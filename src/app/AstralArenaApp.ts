import { GameAudio } from '../audio/GameAudio';
import { hasLineOfSight, raycastWorld } from '../game/collision';
import { MAPS } from '../game/map';
import {
  add,
  clamp,
  directionFromAngles,
  vec3,
} from '../game/math';
import { canonicalFormatForMode, isTeamGameMode, rulesForMode } from '../game/modeRules';
import {
  createDefaultConfig,
  GameSimulation,
  recommendedScoreLimit,
  recommendedTimeLimit,
  towerTurretFiringOrigin,
} from '../game/simulation';
import {
  GAME_PROTOCOL_VERSION,
  type ClientMessage,
  type GameMode,
  type HostMessage,
  type MatchConfig,
  type MatchState,
  type PlayerInput,
  type Team,
} from '../game/types';
import { WEAPONS } from '../game/weapons';
import { InputController } from '../input/InputController';
import { isValidMatchState } from '../network/matchStateValidation';
import { networkSnapshotState } from '../network/networkSnapshot';
import { P2PNetwork, P2PNetworkError } from '../network/P2PNetwork';
import { isValidPlayerInput } from '../network/playerInputProtocol';
import { LocalPlayerPrediction } from '../network/LocalPlayerPrediction';
import { RemoteInputBuffer } from '../network/RemoteInputBuffer';
import type { ArenaRenderer } from '../render/ArenaRenderer';
import type { ExternalWeaponLoadReport } from '../render/externalWeaponModels';
import { directionalDamagePresentation, latestDamageEventAfter, selectCombatWarning } from './combatHud';
import { presentGameEvents, selectAnnouncementCandidate, type EventPresentation } from './eventPresentation';
import { interactionPromptFor } from './interactionPrompt';
import { buildMotionRadarContacts } from './motionRadar';
import { weaponReticle } from './weaponReticle';

type WireMessage = ClientMessage | HostMessage;
type SessionRole = 'local' | 'host' | 'guest';
type MapId = MatchConfig['mapId'];

const MODE_LABELS: Record<GameMode, string> = {
  deathmatch: 'Deathmatch',
  'team-deathmatch': 'Team Deathmatch',
  'capture-the-flag': 'Capture the Flag',
  juggernaut: 'Juggernaut',
  'towah-of-powah': 'Towah of Powah',
};

const MODE_COPY: Record<GameMode, string> = {
  deathmatch: 'Cada astronauta por su cuenta. Controla el mapa y alcanza primero el límite de bajas.',
  'team-deathmatch': 'Aurora contra Nova. Posicionamiento, fuego cruzado y control de las armas de poder.',
  'capture-the-flag': 'Roba la bandera rival y regresa a base; la tuya debe estar a salvo para capturar.',
  juggernaut: 'Derriba al Coloso para heredar su armadura reforzada y puntuar mientras conservas el rol.',
  'towah-of-powah': 'Escopetas, sin escudos y una torreta letal: toma la cubierta superior de la torre.',
};

const MAP_PRESENTATION: Record<MapId, { code: string; description: string }> = {
  'crater-ridge': {
    code: 'CR',
    description: 'Valle mineral · Torre central · Dos bases',
  },
  'umbra-station': {
    code: 'UM',
    description: 'Estación vertical · Pasarelas · Cuatro alas',
  },
  'titan-expanse': {
    code: 'TX',
    description: 'Altiplano alpino · Relé Towah · Arroyo y cresta',
  },
};

const TEAM_LABELS: Record<Team, string> = { aurora: 'Aurora', nova: 'Nova', neutral: 'Libre' };

const escapeHtml = (value: string): string =>
  value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character] ?? character);

const formatTime = (seconds: number): string => {
  const safe = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`;
};

const isTeamMode = (state: MatchState): boolean =>
  isTeamGameMode(state.config.mode);

const NO_EVENT_PRESENTATIONS: readonly EventPresentation[] = Object.freeze([]);

export class AstralArenaApp {
  private simulation: GameSimulation | null = null;
  private network: P2PNetwork<WireMessage> | null = null;
  private renderer: ArenaRenderer | null = null;
  private input: InputController | null = null;
  private readonly audio = new GameAudio();
  private role: SessionRole | null = null;
  private localPlayerId: string | null = null;
  private currentState: MatchState | null = null;
  private animationFrame = 0;
  private lastFrameAt = 0;
  private accumulator = 0;
  private snapshotTimer = 0;
  private guestSnapshotTimer = 0;
  private guestSnapshotInterval = 0.05;
  private lastGuestSnapshotAt = 0;
  private pingTimer = 0;
  private latency = 0;
  private networkStatus: 'connecting' | 'connected' | 'lost' = 'connecting';
  private inputSequence = 0;
  private lastInput: PlayerInput | null = null;
  private readonly remoteInputBuffer = new RemoteInputBuffer();
  private readonly localPlayerPrediction = new LocalPlayerPrediction();
  private readonly elementCache = new Map<string, Element>();
  private readonly markupCache = new WeakMap<HTMLElement, string>();
  private readonly widthCache = new WeakMap<HTMLElement, number>();
  private tacticalStateCache: MatchState | null = null;
  private readonly tacticalPlayerCache = Object.create(null) as MatchState['players'];
  private guestName = 'Astronauta';
  private gameViewActive = false;
  private lastDamageEvent = 0;
  private lastDamageScannedEvent = 0;
  private lastLocalGrounded: boolean | null = null;
  private lastLocalVerticalVelocity = 0;
  private sniperZoomLevel: 0 | 1 = 0;
  private lastPresentedEvent = 0;
  private activeAlerts: Array<{ presentation: EventPresentation; expiresAt: number }> = [];
  private lastAnnouncement = { message: '', at: 0 };
  private pendingAnnouncement: EventPresentation | null = null;
  private nextTacticalHudAt = 0;
  private lastFrameErrorAt = 0;
  private lastInvalidSnapshotAt = Number.NEGATIVE_INFINITY;
  private damageHudTimer = 0;
  private toastTimer = 0;
  private eventFeedSequence = -1;
  private eventFeedFirstId = -1;
  private eventFeedLength = -1;
  private eventFeedPlayerCount = -1;
  private interactionPromptAction = '';
  private interactionPromptLabel = '';
  private interactionPromptDetail = '';
  private displayedTimeSeconds = -1;
  private externalWeaponPreload: Promise<ExternalWeaponLoadReport> | null = null;
  private sessionGeneration = 0;

  public constructor(private readonly root: HTMLElement) {
    window.addEventListener('keydown', this.handleGlobalKeyDown);
    window.addEventListener('keyup', this.handleGlobalKeyUp);
    this.renderMenu();
    // Start decoding local GLBs while the player is reading the menu. Entering
    // a match awaits the same promise, so normal play never flashes the
    // procedural resilience model before swapping to the authored weapon.
    void this.prepareExternalWeaponModels().catch((error: unknown) => {
      // Entering a match retries a failed chunk request and reports any second
      // failure in the visible UI. Menu prefetch itself must never create an
      // unhandled promise rejection.
      console.warn('No se pudo precargar el equipo desde el menú:', error);
    });
  }

  private prepareExternalWeaponModels(): Promise<ExternalWeaponLoadReport> {
    if (!this.externalWeaponPreload) {
      const request = import('../render/externalWeaponModels')
        .then(({ preloadExternalWeaponModels }) => preloadExternalWeaponModels());
      this.externalWeaponPreload = request.catch((error: unknown) => {
        // A transient chunk/network failure may succeed when Play is pressed.
        this.externalWeaponPreload = null;
        throw error;
      });
    }
    return this.externalWeaponPreload;
  }

  private renderMenu(): void {
    this.destroySession();
    const selectedMapId = this.savedMapId();
    this.root.innerHTML = `
      <main class="menu-shell">
        <div class="menu-sky" aria-hidden="true">
          <div class="distant-planet"></div>
          <div class="ridge ridge-back"></div>
          <div class="ridge ridge-front"></div>
          <div class="stars"></div>
        </div>
        <header class="brand-block">
          <div class="brand-kicker"><span></span> SIMULACIÓN DE COMBATE / <b id="brand-zone-code"></b>-07</div>
          <h1><span>ASTRAL</span> ARENA</h1>
          <p>Combate de arena. Astronautas. Conexión directa.</p>
        </header>

        <section class="menu-grid">
          <div class="config-panel glass-panel">
            <div class="panel-heading">
              <div>
                <span class="eyebrow">CONFIGURAR MISIÓN</span>
                <h2>Partida nueva</h2>
              </div>
              <span class="status-light">LISTO</span>
            </div>

            <label class="field-label" for="player-name">INDICATIVO</label>
            <input id="player-name" class="text-input" maxlength="18" value="${escapeHtml(this.savedName())}" autocomplete="nickname" />

            <label class="field-label" for="map-id">ZONA DE COMBATE</label>
            <select id="map-id" class="select-input">
              ${Object.values(MAPS).map((map) => `<option value="${map.id}"${map.id === selectedMapId ? ' selected' : ''}>${escapeHtml(map.name)}</option>`).join('')}
            </select>

            <div class="field-label">FORMATO DEL MODO</div>
            <div id="mode-format" class="mode-format-card" aria-live="polite">
              <span id="mode-format-icon" class="format-icon">◈</span>
              <div><strong id="mode-format-label">2 JUGADORES</strong><small id="mode-format-detail">TODOS CONTRA TODOS · SIN EQUIPOS</small></div>
              <b id="mode-format-lock">AJUSTABLE</b>
            </div>

            <div class="select-row">
              <label>
                <span class="field-label">MODO</span>
                <select id="game-mode" class="select-input">
                  ${Object.entries(MODE_LABELS).map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}
                </select>
              </label>
              <label>
                <span class="field-label">BOTS</span>
                <select id="difficulty" class="select-input">
                  <option value="recruit">Recluta</option>
                  <option value="veteran" selected>Veterano</option>
                  <option value="legend">Leyenda</option>
                </select>
              </label>
            </div>

            <label id="player-count-field">
              <span class="field-label">JUGADORES EN DEATHMATCH</span>
              <select id="player-count" class="select-input">
                ${Array.from({ length: 7 }, (_, index) => index + 2).map((count) => `<option value="${count}">${count} jugadores · todos contra todos</option>`).join('')}
              </select>
            </label>

            <div id="mode-brief" class="mode-brief">
              <span class="mode-glyph">◎</span>
              <p>${MODE_COPY.deathmatch}</p>
            </div>

            <button id="local-play" class="primary-action" type="button">
              <span><small>JUGAR AHORA</small>Partida local contra bots</span><b>→</b>
            </button>
            <div class="p2p-actions">
              <button id="host-play" class="secondary-action" type="button"><span>⌁</span> Crear partida P2P</button>
              <button id="join-toggle" class="secondary-action" type="button"><span>↗</span> Unirse con código</button>
            </div>
            <label class="network-option">
              <input id="stun-toggle" type="checkbox" />
              <span><strong>Compatibilidad Internet</strong><small>Usa STUN para intentar atravesar NAT; el tráfico del juego sigue siendo directo.</small></span>
            </label>
          </div>

          <aside class="intel-panel">
            <div class="intel-card map-card">
              <div class="map-orbit"><i></i><i></i><i></i><b id="map-code"></b></div>
              <div><span class="eyebrow">ZONA ACTIVA</span><h3 id="map-name"></h3><p id="map-description"></p></div>
            </div>
            <div class="intel-card feature-card">
              <span class="card-number">01</span><div><h3>Combate justo</h3><p>Sin clases ni ventajas. Dos armas, escudos, melee, granadas y pickups disputados.</p></div>
            </div>
            <div class="intel-card feature-card">
              <span class="card-number">02</span><div><h3>Bots de relleno</h3><p>La arena completa automáticamente las plazas elegidas, de 2 a 8, también en una partida totalmente local.</p></div>
            </div>
            <div class="intel-card feature-card">
              <span class="card-number">03</span><div><h3>P2P sin backend</h3><p>El anfitrión simula la partida. Oferta y respuesta se intercambian como códigos copiables.</p></div>
            </div>
            <div class="controls-strip"><kbd>WASD</kbd> MOVER · <kbd>C / CTRL</kbd> AGACHARSE · <kbd>RATÓN</kbd> APUNTAR · <kbd>E</kbd> USAR · <kbd>F</kbd> MELEE · <kbd>G</kbd> GRANADA</div>
          </aside>
        </section>

        <section id="join-panel" class="modal-panel hidden" aria-label="Unirse a partida">
          <button class="modal-close" type="button" aria-label="Cerrar">×</button>
          <span class="eyebrow">ENLACE P2P / PASO 1</span>
          <h2>Pega la oferta del anfitrión</h2>
          <p>El código contiene la descripción WebRTC completa. No se envía a ningún servicio de emparejamiento.</p>
          <textarea id="guest-offer" class="code-area" spellcheck="false" placeholder="AA1…"></textarea>
          <button id="guest-connect" class="primary-action compact" type="button"><span>Generar respuesta</span><b>→</b></button>
        </section>
        <div id="toast" class="toast" role="status"></div>
        <footer class="menu-footer"><span>WEBGL / WEBRTC</span><span>v0.1 · PROTOTIPO JUGABLE</span><span>SIN TELEMETRÍA</span></footer>
      </main>`;

    const modeSelect = this.required<HTMLSelectElement>('#game-mode');
    const playerCountSelect = this.required<HTMLSelectElement>('#player-count');
    const mapSelect = this.required<HTMLSelectElement>('#map-id');
    const updateModePresentation = (): void => {
      const mode = modeSelect.value as GameMode;
      const rules = rulesForMode(mode);
      const deathmatch = mode === 'deathmatch';
      const playerCount = Number(playerCountSelect.value);
      this.required<HTMLElement>('#mode-brief p').textContent = MODE_COPY[mode];
      this.setText('#mode-format-label', deathmatch ? `${playerCount} JUGADORES` : rules.formatLabel);
      this.setText('#mode-format-detail', rules.formatDetail);
      this.setText('#mode-format-icon', rules.teamBased ? '✦' : mode === 'juggernaut' ? '⬢' : '◈');
      this.setText('#mode-format-lock', deathmatch ? 'AJUSTABLE' : 'FIJO');
      this.required<HTMLElement>('#player-count-field').classList.toggle('hidden', !deathmatch);
    };
    modeSelect.addEventListener('change', updateModePresentation);
    playerCountSelect.addEventListener('change', updateModePresentation);
    const updateMapPresentation = (): void => {
      const mapId = mapSelect.value as MapId;
      const map = MAPS[mapId];
      const presentation = MAP_PRESENTATION[mapId];
      this.setText('#brand-zone-code', presentation.code);
      this.setText('#map-code', presentation.code);
      this.setText('#map-name', map.name);
      this.setText('#map-description', presentation.description);
    };
    mapSelect.addEventListener('change', updateMapPresentation);
    updateModePresentation();
    updateMapPresentation();
    this.required<HTMLButtonElement>('#local-play').addEventListener('click', () => this.startLocal());
    this.required<HTMLButtonElement>('#host-play').addEventListener('click', () => void this.startHostLobby());
    const joinPanel = this.required<HTMLElement>('#join-panel');
    this.required<HTMLButtonElement>('#join-toggle').addEventListener('click', () => joinPanel.classList.remove('hidden'));
    this.required<HTMLButtonElement>('.modal-close').addEventListener('click', () => joinPanel.classList.add('hidden'));
    this.required<HTMLButtonElement>('#guest-connect').addEventListener('click', () => void this.connectAsGuest());
  }

  private startLocal(): void {
    // `startGameView` performs asynchronous module/GLB preparation. Ignore a
    // second activation while that first view is already starting so it
    // cannot replace the simulation underneath a renderer for another map.
    if (this.gameViewActive) return;
    this.audio.uiConfirm();
    const config = this.readConfig();
    this.role = 'local';
    this.localPlayerId = 'local-player';
    this.simulation = new GameSimulation(config, [{ id: this.localPlayerId, name: config.playerName, kind: 'human' }]);
    this.currentState = this.simulation.state;
    void this.startGameView(this.currentState);
  }

  private async startHostLobby(): Promise<void> {
    if (this.gameViewActive) return;
    this.audio.uiConfirm();
    const config = this.readConfig();
    this.role = 'host';
    this.localPlayerId = 'host-player';
    this.simulation = new GameSimulation(config, [{ id: this.localPlayerId, name: config.playerName, kind: 'human' }]);
    this.currentState = this.simulation.state;
    this.createNetwork(this.stunEnabled());
    this.renderHostLobby();
    await this.generateHostOffer();
  }

  private renderHostLobby(): void {
    const state = this.simulation?.state;
    if (!state) return;
    const maxPlayers = this.simulation?.maxPlayers ?? rulesForMode(state.config.mode).maxPlayers;
    this.elementCache.clear();
    this.root.innerHTML = `
      <main class="lobby-shell">
        <div class="lobby-backdrop"></div>
        <header class="lobby-header">
          <button id="lobby-back" class="icon-button" type="button">←</button>
          <div><span class="eyebrow">SALA P2P / ANFITRIÓN · ${escapeHtml(MAPS[state.config.mapId].name)}</span><h1>${MODE_LABELS[state.config.mode]} <i>·</i> ${state.config.mode === 'deathmatch' ? `${state.config.playerCount} JUGADORES` : rulesForMode(state.config.mode).formatLabel}</h1></div>
          <span class="connection-badge"><i></i> DIRECTA</span>
        </header>
        <section class="lobby-grid">
          <div class="glass-panel signal-panel">
            <div class="step-title"><span>1</span><div><h2>Comparte esta oferta</h2><p>Una oferta conecta a un invitado. Para más jugadores, genera otra cuando termines.</p></div></div>
            <textarea id="host-offer" class="code-area large" readonly spellcheck="false" placeholder="Generando candidatos ICE…"></textarea>
            <div class="inline-actions">
              <button id="copy-offer" class="secondary-action" type="button">Copiar oferta</button>
              <button id="new-offer" class="secondary-action" type="button">Nueva invitación</button>
            </div>
            <div class="step-title second"><span>2</span><div><h2>Pega su respuesta</h2><p>La conexión se abrirá directamente entre ambos navegadores.</p></div></div>
            <textarea id="host-answer" class="code-area" spellcheck="false" placeholder="La respuesta que te envíe el invitado…"></textarea>
            <button id="accept-answer" class="primary-action compact" type="button"><span>Aceptar respuesta</span><b>→</b></button>
            <div id="signal-status" class="signal-status">Preparando enlace…</div>
          </div>
          <aside class="glass-panel roster-panel">
            <div class="panel-heading"><div><span class="eyebrow">TRIPULACIÓN</span><h2>Jugadores y bots</h2></div><span id="roster-count">0 / ${maxPlayers}</span></div>
            <div id="lobby-roster" class="lobby-roster"></div>
            <div class="lobby-note"><span>BOT FILL</span> Los bots se sustituyen automáticamente al entrar una persona.</div>
            <button id="launch-game" class="primary-action launch" type="button"><span><small>LA TRIPULACIÓN PUEDE UNIRSE DESPUÉS</small>Entrar en la arena</span><b>▶</b></button>
          </aside>
        </section>
        <div id="toast" class="toast" role="status"></div>
      </main>`;
    this.updateLobbyRoster();
    this.required<HTMLButtonElement>('#lobby-back').addEventListener('click', () => this.renderMenu());
    this.required<HTMLButtonElement>('#copy-offer').addEventListener('click', () => void this.copyFrom('#host-offer'));
    this.required<HTMLButtonElement>('#new-offer').addEventListener('click', () => {
      this.network?.cancelPendingOffers();
      void this.generateHostOffer();
    });
    this.required<HTMLButtonElement>('#accept-answer').addEventListener('click', () => void this.acceptHostAnswer());
    this.required<HTMLButtonElement>('#launch-game').addEventListener('click', () => {
      if (this.simulation) void this.startGameView(this.simulation.state);
    });
  }

  private async generateHostOffer(): Promise<void> {
    const output = this.root.querySelector<HTMLTextAreaElement>('#host-offer');
    const status = this.root.querySelector<HTMLElement>('#signal-status');
    if (!this.network || !output) return;
    output.value = '';
    output.placeholder = 'Recopilando rutas directas…';
    if (status) status.textContent = 'Generando oferta; puede tardar unos segundos…';
    try {
      output.value = await this.network.hostCreateOffer();
      output.placeholder = '';
      if (status) status.textContent = 'Oferta lista. Envíala al invitado por el canal que prefieras.';
    } catch (error) {
      this.reportError(error);
      if (status) status.textContent = 'No se pudo generar otra oferta.';
    }
  }

  private async acceptHostAnswer(): Promise<void> {
    const answer = this.root.querySelector<HTMLTextAreaElement>('#host-answer')?.value.trim() ?? '';
    if (!this.network || !answer) {
      this.showToast('Pega primero la respuesta del invitado.');
      return;
    }
    try {
      await this.network.hostAcceptAnswer(answer);
      const field = this.root.querySelector<HTMLTextAreaElement>('#host-answer');
      if (field) field.value = '';
      const status = this.root.querySelector<HTMLElement>('#signal-status');
      if (status) status.textContent = 'Respuesta aceptada. Esperando a que abra el canal…';
      this.showToast('Respuesta válida; negociando conexión.');
    } catch (error) {
      this.reportError(error);
    }
  }

  private async connectAsGuest(): Promise<void> {
    if (this.gameViewActive) return;
    const offer = this.root.querySelector<HTMLTextAreaElement>('#guest-offer')?.value.trim() ?? '';
    if (!offer) {
      this.showToast('Pega la oferta del anfitrión.');
      return;
    }
    this.audio.uiConfirm();
    const config = this.readConfig();
    this.guestName = config.playerName;
    this.role = 'guest';
    this.localPlayerId = null;
    this.createNetwork(this.stunEnabled());
    this.elementCache.clear();
    this.root.innerHTML = `
      <main class="connect-shell">
        <div class="connection-radar"><i></i><i></i><i></i><b>↗</b></div>
        <span class="eyebrow">ENLACE P2P / PASO 2</span>
        <h1>Devuelve esta respuesta</h1>
        <p>Envíala al anfitrión y pídele que pulse “Aceptar respuesta”. Esta pantalla avanzará sola cuando el canal esté listo.</p>
        <textarea id="guest-answer" class="code-area large" readonly spellcheck="false" placeholder="Generando respuesta…"></textarea>
        <button id="copy-answer" class="primary-action compact" type="button"><span>Copiar respuesta</span><b>⌘</b></button>
        <div id="guest-status" class="signal-status searching"><i></i> Recopilando rutas directas…</div>
        <button id="cancel-connect" class="text-button" type="button">Cancelar y volver</button>
        <div id="toast" class="toast" role="status"></div>
      </main>`;
    this.required<HTMLButtonElement>('#copy-answer').addEventListener('click', () => void this.copyFrom('#guest-answer'));
    this.required<HTMLButtonElement>('#cancel-connect').addEventListener('click', () => this.renderMenu());
    try {
      const answer = await this.network!.guestAcceptOffer(offer);
      this.required<HTMLTextAreaElement>('#guest-answer').value = answer;
      this.required<HTMLElement>('#guest-status').innerHTML = '<i></i> Respuesta lista. Esperando al anfitrión…';
    } catch (error) {
      this.reportError(error);
      this.required<HTMLElement>('#guest-status').textContent = 'La oferta no es válida o ha caducado.';
    }
  }

  private createNetwork(useStun: boolean): void {
    this.network?.close();
    this.networkStatus = 'connecting';
    this.network = new P2PNetwork<WireMessage>({
      maxPeers: this.role === 'host' ? Math.max(1, (this.simulation?.maxPlayers ?? 8) - 1) : 7,
      rtcConfiguration: useStun
        ? { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }
        : { iceServers: [] },
    });
    this.network.on('connection', (event) => {
      if (event.status === 'connected') {
        this.networkStatus = 'connected';
        if (this.role === 'guest') {
          this.network?.sendToHost({ kind: 'hello', name: this.guestName, protocol: GAME_PROTOCOL_VERSION });
          const status = this.root.querySelector<HTMLElement>('#guest-status');
          if (status) status.innerHTML = '<i></i> Canal abierto. Sincronizando arena…';
        } else {
          const status = this.root.querySelector<HTMLElement>('#signal-status');
          if (status) status.textContent = 'Invitado conectado. Puedes iniciar o generar otra invitación.';
        }
        this.showToast('Enlace P2P establecido.');
      }
      if (this.role === 'guest' && event.status === 'disconnected') {
        this.networkStatus = 'connecting';
        this.showToast('Conexión interrumpida; WebRTC intenta recuperarla.');
      }
      if (this.role === 'guest' && ['failed', 'closed'].includes(event.status)) {
        this.networkStatus = 'lost';
        this.showConnectionLost();
      }
      if (this.role === 'host' && ['disconnected', 'failed', 'closed'].includes(event.status)) {
        this.simulation?.removeRemotePlayer(event.peerId);
        this.remoteInputBuffer.delete(event.peerId);
        this.updateLobbyRoster();
      }
    });
    this.network.on('message', (event) => this.handleWireMessage(event.peerId, event.data));
    this.network.on('error', (event) => this.reportError(event.error));
  }

  private handleWireMessage(peerId: string, message: WireMessage): void {
    if (this.role === 'host') {
      if (!this.simulation) return;
      if (message.kind === 'hello') {
        if (typeof message.name !== 'string') return;
        if (message.protocol !== GAME_PROTOCOL_VERSION) {
          this.network?.sendToPeer(peerId, { kind: 'error', message: 'La versión del juego no es compatible con esta sala.' });
          return;
        }
        this.remoteInputBuffer.delete(peerId);
        const player = this.simulation.addRemotePlayer(peerId, message.name);
        if (!player) {
          this.network?.sendToPeer(peerId, { kind: 'error', message: 'La arena está completa.' });
          return;
        }
        this.network?.sendToPeer(peerId, {
          kind: 'welcome',
          playerId: player.id,
          protocol: GAME_PROTOCOL_VERSION,
        });
        this.network?.sendToPeer(peerId, this.createSnapshot());
        this.updateLobbyRoster();
      } else if (message.kind === 'input') {
        if (isValidPlayerInput(message.input)) this.queueRemoteInput(peerId, message.input);
      } else if (message.kind === 'ping') {
        this.network?.sendToPeer(peerId, { kind: 'pong', sentAt: message.sentAt });
      }
      return;
    }

    if (this.role === 'guest') {
      if (message.kind === 'welcome') {
        if (message.protocol !== GAME_PROTOCOL_VERSION) {
          this.showToast('La versión del anfitrión no es compatible.');
          return;
        }
        this.localPlayerId = message.playerId;
        const state = this.currentState;
        const player = state?.players[message.playerId];
        if (state && player) {
          // A reliable channel is ordered today, but accepting this ordering as
          // a state-machine invariant makes a future realtime channel safe too.
          this.localPlayerPrediction.reconcile(state, message.playerId, player.lastProcessedInput);
          this.localPlayerPrediction.applyTo(state, message.playerId, 0);
          if (!this.gameViewActive) void this.startGameView(state);
        }
      } else if (message.kind === 'snapshot') {
        const receivedAt = performance.now();
        const snapshot = message.state as unknown;
        const localPlayerId = this.localPlayerId;
        const invalidSnapshot = !isValidMatchState(snapshot)
          || (localPlayerId !== null && snapshot.players[localPlayerId] === undefined)
          || (this.gameViewActive && this.currentState !== null && snapshot.matchId !== this.currentState.matchId);
        if (invalidSnapshot) {
          if (receivedAt - this.lastInvalidSnapshotAt > 2000) {
            this.lastInvalidSnapshotAt = receivedAt;
            this.showToast('Se descartó una instantánea P2P inválida.');
          }
          return;
        }
        if (this.currentState?.matchId === snapshot.matchId && snapshot.tick < this.currentState.tick) return;
        if (this.lastGuestSnapshotAt > 0) {
          const observedInterval = clamp((receivedAt - this.lastGuestSnapshotAt) / 1000, 0.025, 0.1);
          this.guestSnapshotInterval += (observedInterval - this.guestSnapshotInterval) * 0.2;
        }
        this.lastGuestSnapshotAt = receivedAt;
        this.guestSnapshotTimer = 0;
        this.currentState = snapshot;
        if (localPlayerId) {
          const acknowledgedInput = snapshot.players[localPlayerId]?.lastProcessedInput ?? 0;
          this.localPlayerPrediction.reconcile(snapshot, localPlayerId, acknowledgedInput);
          this.localPlayerPrediction.applyTo(snapshot, localPlayerId, 0);
        }
        if (!this.gameViewActive && localPlayerId) void this.startGameView(snapshot);
      } else if (message.kind === 'pong') {
        this.latency = Math.round(performance.now() - message.sentAt);
      } else if (message.kind === 'error') {
        this.showToast(message.message);
      }
    }
  }

  private async startGameView(state: MatchState): Promise<void> {
    if (this.gameViewActive) return;
    const viewGeneration = this.sessionGeneration;
    const viewMatchId = state.matchId;
    this.gameViewActive = true;
    this.currentState = state;
    // Countdown events describe the match being entered (not stale history),
    // e.g. the initial Coloso assignment. Mid-match guests still skip backlog.
    const initialEventCursor = state.phase === 'countdown' ? 0 : state.eventSequence;
    this.audio.beginSession(initialEventCursor);
    this.lastPresentedEvent = initialEventCursor;
    this.activeAlerts = [];
    this.lastAnnouncement = { message: '', at: 0 };
    this.pendingAnnouncement = null;
    this.sniperZoomLevel = 0;
    this.nextTacticalHudAt = 0;
    this.lastFrameErrorAt = 0;
    this.lastLocalGrounded = null;
    this.lastLocalVerticalVelocity = 0;
    this.displayedTimeSeconds = -1;
    this.interactionPromptAction = '';
    this.interactionPromptLabel = '';
    this.interactionPromptDetail = '';
    const loadingIndicator = this.root.querySelector<HTMLElement>('.status-light');
    if (loadingIndicator) loadingIndicator.textContent = 'PREPARANDO EQUIPO';
    let prepared: [typeof import('../render/ArenaRenderer'), ExternalWeaponLoadReport];
    try {
      prepared = await Promise.all([
        import('../render/ArenaRenderer'),
        this.prepareExternalWeaponModels(),
      ]);
    } catch (error) {
      if (viewGeneration !== this.sessionGeneration) return;
      console.error('No se pudo preparar la vista de juego:', error);
      this.renderMenu();
      this.showToast('No se pudo preparar el equipo gráfico. Vuelve a intentarlo.');
      return;
    }
    if (!this.gameViewActive || viewGeneration !== this.sessionGeneration) return;
    if (this.currentState?.matchId !== viewMatchId) {
      // A newer session superseded the async preparation without going
      // through the usual teardown. Release the start guard so that session
      // can build its own view instead of remaining permanently in limbo.
      this.gameViewActive = false;
      return;
    }
    const [{ ArenaRenderer }, weaponAssets] = prepared;
    if (weaponAssets.failed.length > 0) {
      // Local files should succeed in normal operation. A procedural model is
      // retained only for corrupt assets, interrupted requests or GPU decode
      // failures so a single weapon cannot make the whole match unplayable.
      console.warn('Modelos GLB no disponibles; se usará el modelo de resiliencia:', weaponAssets.failed);
    }
    this.elementCache.clear();
    this.root.innerHTML = `
      <main class="game-shell">
        <div id="scene-host" class="scene-host"></div>
        <div class="hud-vignette"></div>
        <div id="damage-hud" class="damage-hud" aria-hidden="true"><i></i></div>
        <div class="hud-top">
          <div class="hud-mode"><span id="hud-mode-name">${MODE_LABELS[state.config.mode]}</span><small id="hud-objective"></small></div>
          <div class="hud-score">
            <span id="score-left" class="team-aurora">0</span><b id="match-time">${formatTime(state.timeRemaining)}</b><span id="score-right" class="team-nova">0</span>
          </div>
          <div class="hud-network"><i></i><span id="net-state">${this.role === 'local' ? 'LOCAL' : this.role === 'host' ? 'HOST P2P' : 'P2P'}</span><small id="ping-value"></small></div>
        </div>
        <div id="kill-feed" class="kill-feed"></div>
        <div id="combat-alerts" class="combat-alerts" aria-live="polite"></div>
        <div id="objective-marker" class="objective-marker"></div>
        <div id="crosshair" class="crosshair" aria-hidden="true"><i></i><i></i><i></i><i></i><b></b></div>
        <div id="combat-warning" class="combat-warning" aria-live="polite"></div>
        <div id="interaction-prompt" class="interaction-prompt" aria-live="polite"></div>
        <div id="turret-hud" class="turret-hud" aria-hidden="true"><span>EMPLAZAMIENTO M41</span><strong>CONTROL MANUAL</strong><small>RATÓN · APUNTAR &nbsp; LMB · FUEGO &nbsp; E · SALIR</small></div>
        <div id="scope-overlay" class="scope-overlay"><div></div><span id="scope-zoom">5×</span><small>RUEDA / Z · CAMBIAR AUMENTO</small></div>
        <div id="motion-radar" class="motion-radar" role="img" aria-label="Radar de movimiento, alcance 25 metros">
          <div class="radar-face"><i></i><i></i><i></i><b></b><span id="radar-blips"></span></div>
          <small>25 M · MOVIMIENTO</small>
        </div>
        <div class="hud-bottom-left">
          <div id="shield-block" class="vital-block shield-vital"><span>BARRERA</span><div><i id="shield-bar"></i></div><b id="shield-value">100</b></div>
          <div class="vital-block health-vital"><span>INTEGRIDAD</span><div><i id="health-bar"></i></div><b id="health-value">70</b></div>
          <div class="grenade-count"><span>◆</span><b id="grenade-value">2</b> FRAG</div>
        </div>
        <div class="hud-bottom-right">
          <div class="weapon-label"><span id="weapon-role">AUTOMÁTICO</span><strong id="weapon-name">Rifle de pulso</strong></div>
          <div class="ammo-readout"><b id="ammo-mag">32</b><span>/ <i id="ammo-reserve">128</i></span></div>
          <div id="reload-state" class="reload-state"></div>
        </div>
        <div id="countdown" class="countdown"></div>
        <div id="death-state" class="death-state"></div>
        <div id="click-hint" class="click-hint"><span>⊙</span> HAZ CLIC PARA CAPTURAR EL RATÓN</div>
        <div id="scoreboard" class="scoreboard glass-panel"><div class="scoreboard-head"><span>JUGADOR</span><span>PUNTOS</span><span>BAJAS</span><span>MUERTES</span></div><div id="scoreboard-rows"></div></div>
        <button id="leave-game" class="game-menu-button" type="button">☰</button>
        <div id="pause-panel" class="pause-panel glass-panel hidden">
          <span class="eyebrow">MENÚ DE MISIÓN</span><h2>Partida en curso</h2>
          <p>La simulación continúa mientras el ratón está libre.</p>
          <div class="control-grid"><span><kbd>WASD</kbd>Mover</span><span><kbd>ESPACIO</kbd>Saltar</span><span><kbd>C / CTRL</kbd>Agacharse</span><span><kbd>E</kbd>Usar / torreta</span><span><kbd>Q</kbd>Cambiar</span><span><kbd>R</kbd>Recargar</span><span><kbd>F</kbd>Melee</span><span><kbd>G</kbd>Granada</span><span><kbd>RMB</kbd>Apuntar</span><span><kbd>Z / RUEDA</kbd>Zoom sniper</span></div>
          <button id="resume-game" class="primary-action compact" type="button"><span>Volver a la arena</span><b>→</b></button>
          <button id="exit-game" class="text-button danger" type="button">Abandonar partida</button>
        </div>
        <div id="match-result" class="match-result hidden"><span class="eyebrow">PARTIDA FINALIZADA</span><h1 id="result-title">Victoria</h1><p id="result-subtitle"></p><button id="result-exit" class="primary-action compact" type="button"><span>Volver al menú</span><b>→</b></button></div>
        <div id="toast" class="toast" role="status"></div>
      </main>`;

    const sceneHost = this.required<HTMLElement>('#scene-host');
    this.renderer = new ArenaRenderer(sceneHost, MAPS[state.config.mapId]);
    this.renderer.setLocalPlayer(this.localPlayerId);
    this.input = new InputController(
      this.renderer.canvas,
      (locked) => {
        this.input?.setEnabled(locked);
        this.root.querySelector('#click-hint')?.classList.toggle('hidden', locked);
        if (locked) this.root.querySelector('#pause-panel')?.classList.add('hidden');
        else if (this.currentState?.phase !== 'finished') this.root.querySelector('#pause-panel')?.classList.remove('hidden');
      },
      (direction) => this.stepSniperZoom(direction),
      () => this.sendGuestInputEdge(),
    );
    this.input.setEnabled(false);
    const local = this.localPlayerId ? state.players[this.localPlayerId] : undefined;
    if (local) this.input.setAngles(local.yaw, local.pitch);
    this.renderer.canvas.addEventListener('click', () => {
      void this.audio.unlock().catch(() => {
        // Browser audio policy must not interrupt pointer-lock/gameplay setup.
      });
    });
    this.required<HTMLButtonElement>('#leave-game').addEventListener('click', () => this.root.querySelector('#pause-panel')?.classList.remove('hidden'));
    this.required<HTMLButtonElement>('#resume-game').addEventListener('click', () => this.renderer?.canvas.requestPointerLock());
    this.required<HTMLButtonElement>('#exit-game').addEventListener('click', () => this.renderMenu());
    this.required<HTMLButtonElement>('#result-exit').addEventListener('click', () => this.renderMenu());
    this.lastFrameAt = performance.now();
    this.accumulator = 0;
    cancelAnimationFrame(this.animationFrame);
    this.animationFrame = requestAnimationFrame(this.frame);
  }

  private frame = (now: number): void => {
    if (!this.gameViewActive) return;
    this.animationFrame = requestAnimationFrame(this.frame);
    try {
      this.advanceFrame(now);
    } catch (error) {
      if (now - this.lastFrameErrorAt > 2000) {
        this.lastFrameErrorAt = now;
        console.error('Frame de juego recuperado tras un error:', error);
        this.showToast('Se ha recuperado un error interno sin detener la partida.');
      }
    }
  };

  private advanceFrame(now: number): void {
    const delta = clamp((now - this.lastFrameAt) / 1000, 0, 0.1);
    this.lastFrameAt = now;
    const fixed = 1 / 60;

    if ((this.role === 'local' || this.role === 'host') && this.simulation) {
      this.accumulator += delta;
      while (this.accumulator >= fixed) {
        if (this.input && this.localPlayerId) {
          this.lastInput = this.input.sample(++this.inputSequence, fixed);
          this.simulation.setInput(this.localPlayerId, this.lastInput);
        }
        if (this.role === 'host') this.applyRemoteInputsForTick();
        this.simulation.step(fixed);
        this.accumulator -= fixed;
      }
      this.currentState = this.simulation.state;
      if (this.role === 'host' && this.network) {
        this.snapshotTimer += delta;
        if (this.snapshotTimer >= 0.05) {
          this.snapshotTimer %= 0.05;
          // Keep at most roughly one full-state snapshot queued on the reliable
          // channel. A skipped state is superseded by the next tick, leaving
          // room for welcome, pong and error control messages on the same path.
          this.network.broadcastLazy(() => this.createSnapshot(), { maxBufferedAmount: 8 * 1024 });
        }
      }
    } else if (this.role === 'guest' && this.network && this.input && this.localPlayerId) {
      // After a long guest frame the host has already continued with the last
      // received control. Replaying a large burst of newly sampled commands
      // would incorrectly predict that fresh input across the whole stall.
      this.accumulator = Math.min(this.accumulator + delta, fixed * 3);
      this.guestSnapshotTimer += delta;
      const sampledInput = this.input.sample(this.inputSequence + 1, delta);
      this.lastInput = sampledInput;
      if (this.currentState) {
        this.localPlayerPrediction.setLook(
          this.currentState,
          this.localPlayerId,
          sampledInput,
        );
      }
      const hostConnected = this.network.isPeerConnected('host');
      while (this.accumulator >= fixed) {
        const sequence = ++this.inputSequence;
        const input = sequence === sampledInput.sequence
          ? sampledInput
          : { ...sampledInput, sequence };
        this.lastInput = input;
        if (this.currentState) {
          this.localPlayerPrediction.advance(this.currentState, this.localPlayerId, input, fixed);
        }
        if (hostConnected) {
          this.network.sendToHost({ kind: 'input', input });
        }
        this.accumulator -= fixed;
      }
      if (this.currentState) {
        this.localPlayerPrediction.applyTo(this.currentState, this.localPlayerId, delta);
      }
      this.pingTimer += delta;
      if (hostConnected && this.pingTimer >= 2) {
        this.pingTimer = 0;
        this.network.sendToHost({ kind: 'ping', sentAt: performance.now() });
      }
    }

    if (this.currentState && this.renderer) {
      const opticalAimActive = this.effectiveOpticalAim(this.currentState);
      const localPlayer = this.localPlayerId ? this.currentState.players[this.localPlayerId] : undefined;
      const activeWeapon = localPlayer?.inventory[localPlayer.activeWeapon];
      if (!opticalAimActive || activeWeapon?.id !== 'sniper') this.sniperZoomLevel = 0;
      this.renderer.setLocalViewAim(opticalAimActive, this.sniperZoomLevel);
      const interpolation = this.role === 'guest'
        ? clamp(this.guestSnapshotTimer / this.guestSnapshotInterval, 0, 1)
        : this.accumulator / fixed;
      this.renderer.render(this.currentState, interpolation, true, this.accumulator / fixed);
      this.updateHud(this.currentState, opticalAimActive);
      this.audio.consume(this.currentState.events, this.localPlayerId);
    }
  }

  private effectiveOpticalAim(state: MatchState): boolean {
    if (!this.localPlayerId || !this.lastInput?.aim) return false;
    const player = state.players[this.localPlayerId];
    if (!player?.alive || player.aimSuppressed) return false;
    const operatingTurret = state.config.mode === 'towah-of-powah'
      && state.tower.turretOwnerId === player.id;
    if (operatingTurret) return false;
    const weapon = player.inventory[player.activeWeapon];
    return Boolean(weapon && WEAPONS[weapon.id].zoomFov?.length);
  }

  private updateHud(state: MatchState, opticalAimActive: boolean): void {
    if (!this.localPlayerId) return;
    const player = state.players[this.localPlayerId];
    if (!player) return;
    if (player.alive) {
      if (this.lastLocalGrounded === true && !player.grounded && player.velocity.y > 0.35) {
        this.audio.movement('jump', Math.min(1, player.velocity.y / 6.5));
      } else if (this.lastLocalGrounded === false && player.grounded) {
        this.audio.movement('land', clamp(-this.lastLocalVerticalVelocity / 8, 0.28, 1));
      }
      this.lastLocalGrounded = player.grounded;
      this.lastLocalVerticalVelocity = player.velocity.y;
    } else {
      this.lastLocalGrounded = null;
      this.lastLocalVerticalVelocity = 0;
    }
    const weapon = player.inventory[player.activeWeapon];
    const definition = weapon ? WEAPONS[weapon.id] : null;
    const operatingTurret = state.config.mode === 'towah-of-powah'
      && state.tower.turretOwnerId === player.id;
    const shieldDenominator = Math.max(100, player.maxShield, player.shield);
    this.setWidth('#shield-bar', player.maxShield === 0 ? 0 : (player.shield / shieldDenominator) * 100);
    this.setWidth('#health-bar', (player.health / 70) * 100);
    this.setText('#shield-value', player.maxShield === 0 ? 'OFF' : String(Math.ceil(player.shield)));
    this.setText('#health-value', String(Math.max(0, Math.ceil(player.health))));
    this.setText('#grenade-value', String(player.grenades));
    const shieldBlock = this.query<HTMLElement>('#shield-block');
    shieldBlock?.classList.toggle('disabled', player.maxShield === 0);
    const shieldRecharging = player.alive
      && player.maxShield > 0
      && player.shield < player.maxShield
      && state.elapsed - player.lastDamageAt >= 5;
    shieldBlock?.classList.toggle('recharging', shieldRecharging);
    if (operatingTurret) {
      this.setText('#weapon-name', 'Torreta M41');
      this.setText('#weapon-role', 'EMPLAZAMIENTO CONECTADO');
      this.setText('#ammo-mag', '∞');
      this.setText('#ammo-reserve', 'ACTIVA');
      this.setText('#reload-state', 'CONTROL MANUAL · 420 RPM');
    } else if (weapon && definition) {
      this.setText('#weapon-name', definition.label);
      this.setText('#weapon-role', definition.role.toUpperCase());
      this.setText('#ammo-mag', String(weapon.magazine));
      this.setText('#ammo-reserve', String(weapon.reserve));
      this.setText('#reload-state', weapon.reloadTimer > 0 ? `RECARGANDO ${weapon.reloadTimer.toFixed(1)}` : '');
    }
    const displayedTimeSeconds = Math.max(0, Math.ceil(state.timeRemaining));
    if (displayedTimeSeconds !== this.displayedTimeSeconds) {
      this.displayedTimeSeconds = displayedTimeSeconds;
      this.setText('#match-time', formatTime(displayedTimeSeconds));
    }
    this.setText('#ping-value', this.role === 'guest' && this.networkStatus === 'connected' ? `${this.latency} MS` : '');
    if (this.role === 'guest') this.setText('#net-state', this.networkStatus === 'connected' ? 'P2P' : this.networkStatus === 'lost' ? 'SIN HOST' : 'RECONECTANDO');
    const sniperScoped = opticalAimActive && weapon?.id === 'sniper';
    if (!sniperScoped) this.sniperZoomLevel = 0;
    const zoomFov = definition?.zoomFov?.[weapon?.id === 'sniper' ? this.sniperZoomLevel : 0];
    this.input?.setLookSensitivityScale(
      opticalAimActive ? clamp((zoomFov ?? 62) / 74, 0.12, 0.86) : 1,
    );
    this.query('#scope-overlay')?.classList.toggle('active', sniperScoped);
    const crosshair = this.query<HTMLElement>('#crosshair');
    crosshair?.classList.toggle('scoped', sniperScoped);
    crosshair?.classList.toggle('firing', Boolean(this.lastInput?.fire && (operatingTurret ? state.tower.turretCooldown : weapon?.cooldown)));
    if (crosshair) {
      const bloom = operatingTurret ? 0 : clamp(weapon?.bloom ?? 0, 0, 1);
      const reticle = operatingTurret ? 'turret' : weaponReticle(weapon?.id);
      if (crosshair.dataset.reticle !== reticle) crosshair.dataset.reticle = reticle;
      const bloomValue = bloom.toFixed(3);
      const bloomScale = (1 + bloom * 0.32).toFixed(3);
      if (crosshair.style.getPropertyValue('--weapon-bloom') !== bloomValue) {
        crosshair.style.setProperty('--weapon-bloom', bloomValue);
      }
      if (crosshair.style.getPropertyValue('--reticle-bloom-scale') !== bloomScale) {
        crosshair.style.setProperty('--reticle-bloom-scale', bloomScale);
      }
    }
    const warning = !operatingTurret && player.alive
      ? selectCombatWarning(weapon, definition?.magazineSize, player.grenades, Boolean(this.lastInput?.grenade))
      : null;
    const combatWarning = this.query<HTMLElement>('#combat-warning');
    if (combatWarning) {
      const warningLabel = warning?.label ?? '';
      if (combatWarning.textContent !== warningLabel) combatWarning.textContent = warningLabel;
      const previousTone = combatWarning.dataset.tone;
      if (previousTone && previousTone !== warning?.tone) combatWarning.classList.remove(previousTone);
      combatWarning.classList.toggle('visible', warning !== null);
      if (warning && previousTone !== warning.tone) combatWarning.classList.add(warning.tone);
      if (warning) combatWarning.dataset.tone = warning.tone;
      else delete combatWarning.dataset.tone;
    }
    this.query('.hud-bottom-right')?.classList.toggle('turret-active', operatingTurret);
    const turretHud = this.query<HTMLElement>('#turret-hud');
    turretHud?.classList.toggle('active', operatingTurret);
    const turretHidden = String(!operatingTurret);
    if (turretHud && turretHud.getAttribute('aria-hidden') !== turretHidden) {
      turretHud.setAttribute('aria-hidden', turretHidden);
    }
    this.updateInteractionPrompt(state, player);
    this.setText('#scope-zoom', this.sniperZoomLevel === 0 ? '5×' : '10×');
    const radar = this.query<HTMLElement>('#motion-radar');
    radar?.classList.toggle('zoom-hidden', opticalAimActive);
    const radarHidden = String(opticalAimActive);
    if (radar && radar.getAttribute('aria-hidden') !== radarHidden) radar.setAttribute('aria-hidden', radarHidden);
    const hudNow = performance.now();
    if (hudNow >= this.nextTacticalHudAt) {
      const tacticalState = this.presentedTacticalState(state);
      const tacticalPlayer = tacticalState.players[player.id] ?? player;
      this.updateCombatIdentification(tacticalState, tacticalPlayer, operatingTurret ? 70 : definition?.range ?? 120);
      this.updateMotionRadar(tacticalState);
      this.nextTacticalHudAt = hudNow + 1000 / 30;
    }

    if (isTeamMode(state)) {
      this.setText('#score-left', String(state.teamScores.aurora));
      this.setText('#score-right', String(state.teamScores.nova));
    } else {
      let leadingOpponentScore = 0;
      for (const id in state.players) {
        const candidate = state.players[id];
        if (candidate && candidate.id !== player.id && candidate.score > leadingOpponentScore) {
          leadingOpponentScore = candidate.score;
        }
      }
      this.setText('#score-left', String(player.score));
      this.setText('#score-right', String(leadingOpponentScore));
    }
    this.setText('#hud-objective', this.objectiveText(state, player.team));

    this.updateEventPresentation(state);

    const scoreboard = this.query<HTMLElement>('#scoreboard');
    const rows = this.query<HTMLElement>('#scoreboard-rows');
    if (rows && scoreboard?.classList.contains('visible')) {
      const ranked = Object.values(state.players).sort((a, b) => b.score - a.score || b.kills - a.kills);
      const markup = ranked
        .map((candidate) => `<div class="scoreboard-row ${candidate.id === player.id ? 'you' : ''} team-${candidate.team}"><span><i></i>${escapeHtml(candidate.name)}${candidate.kind === 'bot' ? '<small>BOT</small>' : ''}${candidate.isJuggernaut ? '<b>COLOSO</b>' : ''}</span><span>${candidate.score}</span><span>${candidate.kills}</span><span>${candidate.deaths}</span></div>`)
        .join('');
      this.setMarkup(rows, markup);
    }

    const countdown = this.query<HTMLElement>('#countdown');
    if (countdown) {
      const countdownText = state.phase === 'countdown'
        ? (state.countdown > 0.35 ? String(Math.ceil(state.countdown)) : 'COMBATE')
        : '';
      if (countdown.textContent !== countdownText) countdown.textContent = countdownText;
      countdown.classList.toggle('visible', state.phase === 'countdown');
    }
    const death = this.query<HTMLElement>('#death-state');
    if (death) {
      this.setMarkup(
        death,
        player.alive ? '' : `<span>TRAJE FUERA DE SERVICIO</span><b>Reentrada en ${Math.max(0, player.respawnTimer).toFixed(1)}</b>`,
      );
    }

    const newestDamageCandidate = state.events.at(-1);
    if (newestDamageCandidate && newestDamageCandidate.id > this.lastDamageScannedEvent) {
      const damage = latestDamageEventAfter(state.events, player.id, this.lastDamageScannedEvent);
      this.lastDamageScannedEvent = newestDamageCandidate.id;
      if (damage && damage.id > this.lastDamageEvent) {
        this.lastDamageEvent = damage.id;
        const damageHud = this.query<HTMLElement>('#damage-hud');
        if (damageHud) {
          const presentation = directionalDamagePresentation(damage, player);
          damageHud.style.setProperty('--damage-strength', presentation.strength.toFixed(2));
          damageHud.style.setProperty('--damage-angle', `${presentation.angleDegrees.toFixed(1)}deg`);
          damageHud.classList.toggle('shield-only', presentation.tone === 'shield');
          damageHud.classList.toggle('health-hit', presentation.tone === 'health');
          damageHud.classList.remove('active');
          void damageHud.offsetWidth;
          damageHud.classList.add('active');
          window.clearTimeout(this.damageHudTimer);
          this.damageHudTimer = window.setTimeout(() => damageHud.classList.remove('active'), 760);
        }
      }
    }

    if (state.phase === 'finished') {
      const result = this.query<HTMLElement>('#match-result');
      result?.classList.remove('hidden');
      const won = state.winner === player.id || state.winner === player.team;
      this.setText('#result-title', won ? 'VICTORIA' : 'MISIÓN PERDIDA');
      const winnerName = state.winner === 'aurora' || state.winner === 'nova' ? TEAM_LABELS[state.winner] : state.winner ? state.players[state.winner]?.name : '';
      this.setText('#result-subtitle', winnerName ? `Vencedor: ${winnerName}` : 'La arena quedó en tablas.');
      if (document.pointerLockElement) document.exitPointerLock();
    }
  }

  private presentedTacticalState(state: MatchState): MatchState {
    if (!this.renderer) return state;
    if (this.tacticalStateCache?.matchId !== state.matchId) {
      this.tacticalStateCache = null;
      for (const id in this.tacticalPlayerCache) delete this.tacticalPlayerCache[id];
    }

    let changed = false;
    for (const id in state.players) {
      const player = state.players[id];
      if (!player) continue;
      const presented = this.renderer.getPresentedPlayerPosition(id);
      changed ||= presented !== null;
      let tacticalPlayer = this.tacticalPlayerCache[id];
      if (!tacticalPlayer) {
        tacticalPlayer = { ...player, position: presented ?? player.position };
        this.tacticalPlayerCache[id] = tacticalPlayer;
      } else {
        Object.assign(tacticalPlayer, player);
        tacticalPlayer.position = presented ?? player.position;
        // Object.assign intentionally retains absent optional properties.
        if (player.bot === undefined) delete tacticalPlayer.bot;
      }
    }
    for (const id in this.tacticalPlayerCache) {
      if (!Object.hasOwn(state.players, id)) delete this.tacticalPlayerCache[id];
    }
    if (!changed) return state;

    if (this.tacticalStateCache) Object.assign(this.tacticalStateCache, state);
    else this.tacticalStateCache = { ...state, players: this.tacticalPlayerCache };
    this.tacticalStateCache.players = this.tacticalPlayerCache;
    return this.tacticalStateCache;
  }

  private updateCombatIdentification(
    state: MatchState,
    player: MatchState['players'][string],
    weaponRange: number,
  ): void {
    const crosshair = this.query<HTMLElement>('#crosshair');
    const scope = this.query<HTMLElement>('#scope-overlay');
    crosshair?.classList.remove('ally', 'enemy');
    scope?.classList.remove('ally', 'enemy');
    if (!player.alive) return;

    const operatingTurret = state.config.mode === 'towah-of-powah'
      && state.tower.turretOwnerId === player.id;
    const origin = operatingTurret
      ? towerTurretFiringOrigin(state.tower.center)
      : add(player.position, vec3(0, 1.5, 0));
    const aimDirection = directionFromAngles(player.yaw, player.pitch);
    const map = MAPS[state.config.mapId];
    const teamMode = isTeamMode(state);
    const hit = raycastWorld(
      origin,
      aimDirection,
      weaponRange,
      map,
      Object.values(state.players),
      player.id,
    );
    let target = hit?.playerId ? state.players[hit.playerId] : undefined;
    if (!target && !operatingTurret) {
      const weapon = player.inventory[player.activeWeapon];
      const definition = weapon ? WEAPONS[weapon.id] : null;
      const angleLimit = definition?.magnetismAngle ?? 0;
      const assistRange = Math.min(weaponRange, definition?.magnetismRange ?? 0);
      let bestAngle = angleLimit;
      if (angleLimit > 0 && assistRange > 0) {
        const targetPoint = vec3();
        for (const candidate of Object.values(state.players)) {
          if (!candidate.alive || candidate.id === player.id) continue;
          const enemy = !teamMode || candidate.team !== player.team;
          if (!enemy) continue;
          targetPoint.x = candidate.position.x;
          targetPoint.y = candidate.position.y + candidate.height * 0.62;
          targetPoint.z = candidate.position.z;
          const deltaX = targetPoint.x - origin.x;
          const deltaY = targetPoint.y - origin.y;
          const deltaZ = targetPoint.z - origin.z;
          const targetDistance = Math.sqrt(deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ);
          if (targetDistance > assistRange || !hasLineOfSight(origin, targetPoint, map)) continue;
          const aimDot = targetDistance < 0.00001
            ? 0
            : (
                aimDirection.x * deltaX
                + aimDirection.y * deltaY
                + aimDirection.z * deltaZ
              ) / targetDistance;
          const angle = Math.acos(clamp(aimDot, -1, 1));
          if (angle >= bestAngle) continue;
          bestAngle = angle;
          target = candidate;
        }
      }
    }
    if (!target) return;
    const relation = teamMode && target.team === player.team ? 'ally' : 'enemy';
    crosshair?.classList.add(relation);
    scope?.classList.add(relation);
  }

  private updateInteractionPrompt(state: MatchState, player: MatchState['players'][string]): void {
    const element = this.query<HTMLElement>('#interaction-prompt');
    if (!element) return;
    const prompt = interactionPromptFor(state, player);
    const action = prompt?.action ?? '';
    const label = prompt?.label ?? '';
    const detail = prompt?.detail ?? '';
    if (
      action === this.interactionPromptAction
      && label === this.interactionPromptLabel
      && detail === this.interactionPromptDetail
    ) return;
    this.interactionPromptAction = action;
    this.interactionPromptLabel = label;
    this.interactionPromptDetail = detail;
    element.classList.toggle('visible', prompt !== null);
    element.classList.toggle('turret-action', prompt?.action === 'enter-turret' || prompt?.action === 'exit-turret');
    if (!prompt) {
      this.setMarkup(element, '');
      return;
    }
    const markup = `<kbd>${prompt.key}</kbd><span><strong>${escapeHtml(prompt.label)}</strong><small>${escapeHtml(prompt.detail)}</small></span>`;
    this.setMarkup(element, markup);
  }

  private updateMotionRadar(state: MatchState): void {
    if (!this.localPlayerId) return;
    const contacts = buildMotionRadarContacts(state, this.localPlayerId);
    const blips = this.query<HTMLElement>('#radar-blips');
    if (blips) {
      let markup = '';
      for (const contact of contacts) {
        const left = 50 + contact.x * 44;
        const top = 50 + contact.y * 44;
        markup += `<i class="radar-blip ${contact.relation} ${contact.elevation} ${contact.revealedBy}" style="left:${left.toFixed(2)}%;top:${top.toFixed(2)}%;opacity:${contact.opacity.toFixed(2)}" title="${escapeHtml(contact.name)}"></i>`;
      }
      this.setMarkup(blips, markup);
    }
    const local = state.players[this.localPlayerId];
    const moving = Boolean(
      local
      && !local.crouched
      && local.velocity.x * local.velocity.x
        + local.velocity.y * local.velocity.y
        + local.velocity.z * local.velocity.z >= 0.55 * 0.55,
    );
    this.query('#motion-radar')?.classList.toggle('local-moving', moving);
  }

  private updateEventPresentation(state: MatchState): void {
    if (!this.localPlayerId) return;
    const now = performance.now();
    const newestEvent = state.events.at(-1);
    const unseen = newestEvent && newestEvent.id > this.lastPresentedEvent
      ? presentGameEvents(state.events, state, this.localPlayerId, this.lastPresentedEvent)
      : NO_EVENT_PRESENTATIONS;
    if (newestEvent) this.lastPresentedEvent = Math.max(this.lastPresentedEvent, newestEvent.id);

    let alertsChanged = false;
    for (const presentation of unseen) {
      if (presentation.placement === 'center' || presentation.placement === 'both') {
        for (let index = this.activeAlerts.length - 1; index >= 0; index -= 1) {
          if (this.activeAlerts[index]?.presentation.headline === presentation.headline) {
            this.activeAlerts.splice(index, 1);
          }
        }
        this.activeAlerts.push({ presentation, expiresAt: now + presentation.durationMs });
        alertsChanged = true;
      }
    }
    for (let index = this.activeAlerts.length - 1; index >= 0; index -= 1) {
      if ((this.activeAlerts[index]?.expiresAt ?? 0) <= now) {
        this.activeAlerts.splice(index, 1);
        alertsChanged = true;
      }
    }
    if (this.activeAlerts.length > 8) {
      this.activeAlerts.splice(0, this.activeAlerts.length - 8);
      alertsChanged = true;
    }

    const incomingAnnouncement = selectAnnouncementCandidate(unseen);
    if (incomingAnnouncement && (
      this.pendingAnnouncement === null
      || incomingAnnouncement.eventId >= this.pendingAnnouncement.eventId
      || incomingAnnouncement.priority >= 95
    )) {
      this.pendingAnnouncement = incomingAnnouncement;
    }
    const announcement = this.pendingAnnouncement;
    if (announcement?.voice) {
      const repeatedTooSoon = this.lastAnnouncement.message === announcement.voice
        && now - this.lastAnnouncement.at < 2400;
      if (repeatedTooSoon) {
        this.pendingAnnouncement = null;
      } else {
        const result = this.audio.announce(announcement.voice, announcement.priority >= 95);
        if (result === 'spoken') {
          this.lastAnnouncement = { message: announcement.voice, at: now };
          this.pendingAnnouncement = null;
        } else if (result === 'unavailable') {
          this.pendingAnnouncement = null;
        }
      }
    }

    const center = this.query<HTMLElement>('#combat-alerts');
    if (center && alertsChanged) {
      type ActiveAlert = { presentation: EventPresentation; expiresAt: number };
      let highest: ActiveAlert | undefined;
      let secondHighest: ActiveAlert | undefined;
      let newest: ActiveAlert | undefined;
      const higherPriority = (
        left: ActiveAlert,
        right: ActiveAlert,
      ): boolean => left.presentation.priority > right.presentation.priority
        || (
          left.presentation.priority === right.presentation.priority
          && left.presentation.eventId > right.presentation.eventId
        );
      for (const alert of this.activeAlerts) {
        if (!newest || alert.presentation.eventId > newest.presentation.eventId) newest = alert;
        if (!highest || higherPriority(alert, highest)) {
          secondHighest = highest;
          highest = alert;
        } else if (!secondHighest || higherPriority(alert, secondHighest)) {
          secondHighest = alert;
        }
      }
      const visibleAlerts: ActiveAlert[] = highest ? [highest] : [];
      if (newest && newest !== highest) visibleAlerts.push(newest);
      if (visibleAlerts.length < 2 && secondHighest) visibleAlerts.push(secondHighest);
      const markup = visibleAlerts
        .map(({ presentation }) => `<div class="combat-alert ${presentation.tone}"><strong>${escapeHtml(presentation.headline)}</strong>${presentation.detail ? `<span>${escapeHtml(presentation.detail)}</span>` : ''}</div>`)
        .join('');
      this.setMarkup(center, markup);
    }

    const firstEventId = state.events[0]?.id ?? 0;
    let playerCount = 0;
    for (const playerId in state.players) {
      if (Object.hasOwn(state.players, playerId)) playerCount += 1;
    }
    if (
      state.eventSequence !== this.eventFeedSequence
      || firstEventId !== this.eventFeedFirstId
      || state.events.length !== this.eventFeedLength
      || playerCount !== this.eventFeedPlayerCount
    ) {
      this.eventFeedSequence = state.eventSequence;
      this.eventFeedFirstId = firstEventId;
      this.eventFeedLength = state.events.length;
      this.eventFeedPlayerCount = playerCount;
      const allPresentations = presentGameEvents(state.events, state, this.localPlayerId, 0);
      const feedPresentations: EventPresentation[] = [];
      for (let index = allPresentations.length - 1; index >= 0 && feedPresentations.length < 5; index -= 1) {
        const presentation = allPresentations[index];
        if (presentation && presentation.placement !== 'center') feedPresentations.push(presentation);
      }
      const feed = this.query<HTMLElement>('#kill-feed');
      if (feed) {
        const markup = feedPresentations
          .map((presentation) => `<div class="feed-item ${presentation.tone}"><i></i>${escapeHtml(presentation.feedText)}</div>`)
          .join('');
        this.setMarkup(feed, markup);
      }
    }
  }

  private stepSniperZoom(direction: -1 | 1): void {
    if (!this.localPlayerId || !this.currentState || !this.lastInput?.aim) return;
    const player = this.currentState.players[this.localPlayerId];
    const weapon = player?.inventory[player.activeWeapon];
    const zoomSteps = weapon ? WEAPONS[weapon.id].zoomFov : undefined;
    if (!player?.alive || player.aimSuppressed || weapon?.id !== 'sniper' || (zoomSteps?.length ?? 0) < 2) return;
    this.sniperZoomLevel = direction > 0 ? 1 : 0;
  }

  private toggleSniperZoom(): void {
    this.stepSniperZoom(this.sniperZoomLevel === 0 ? 1 : -1);
  }

  private objectiveText(state: MatchState, localTeam: Team): string {
    if (state.config.mode === 'capture-the-flag') {
      const enemyFlag = state.flags.find((flag) => flag.team !== localTeam);
      return enemyFlag?.status === 'carried' ? 'BANDERA EN MOVIMIENTO' : 'CAPTURA LA BANDERA';
    }
    if (state.config.mode === 'juggernaut') {
      const juggernaut = state.juggernautId ? state.players[state.juggernautId] : null;
      return juggernaut ? `COLOSO: ${juggernaut.name.toUpperCase()}` : 'LOCALIZANDO COLOSO';
    }
    if (state.config.mode === 'towah-of-powah') return state.tower.controllingTeam === 'neutral' ? 'TOMA LA TORRE' : `TORRE: ${TEAM_LABELS[state.tower.controllingTeam].toUpperCase()}`;
    return `PRIMERO A ${state.config.scoreLimit}`;
  }

  private createSnapshot(): HostMessage {
    if (!this.simulation) throw new Error('No se puede crear una instantánea sin simulación.');
    return { kind: 'snapshot', state: networkSnapshotState(this.simulation.state) };
  }

  private updateLobbyRoster(): void {
    const roster = this.root.querySelector<HTMLElement>('#lobby-roster');
    if (!roster || !this.simulation) return;
    const players = Object.values(this.simulation.state.players).sort((a, b) => a.team.localeCompare(b.team));
    roster.innerHTML = players.map((player) => `<div class="roster-slot team-${player.team}"><i></i><span><strong>${escapeHtml(player.name)}</strong><small>${player.kind === 'bot' ? `BOT · ${this.simulation?.state.config.difficulty.toUpperCase()}` : player.kind === 'remote' ? 'INVITADO P2P' : 'ANFITRIÓN'}</small></span><b>${TEAM_LABELS[player.team]}</b></div>`).join('');
    this.setText('#roster-count', `${players.filter((player) => player.kind !== 'bot').length} H / ${players.length}`);
  }

  private readConfig(): MatchConfig {
    const name = this.root.querySelector<HTMLInputElement>('#player-name')?.value.trim() || 'Astronauta';
    const mode = (this.root.querySelector<HTMLSelectElement>('#game-mode')?.value ?? 'deathmatch') as GameMode;
    const difficulty = (this.root.querySelector<HTMLSelectElement>('#difficulty')?.value ?? 'veteran') as MatchConfig['difficulty'];
    const mapId = (this.root.querySelector<HTMLSelectElement>('#map-id')?.value ?? 'crater-ridge') as MapId;
    const format = canonicalFormatForMode(mode);
    const requestedPlayerCount = Number(this.root.querySelector<HTMLSelectElement>('#player-count')?.value ?? 2);
    try {
      localStorage.setItem('astral-player-name', name);
      localStorage.setItem('astral-map-id', mapId);
    } catch { /* Storage can be disabled. */ }
    return createDefaultConfig({
      playerName: name,
      mode,
      format,
      playerCount: mode === 'deathmatch' ? requestedPlayerCount : rulesForMode(mode).maxPlayers,
      difficulty,
      mapId,
      scoreLimit: recommendedScoreLimit(mode, format),
      timeLimitSeconds: recommendedTimeLimit(mode, format),
    });
  }

  private savedName(): string {
    try { return localStorage.getItem('astral-player-name') ?? 'Astronauta'; } catch { return 'Astronauta'; }
  }

  private savedMapId(): MapId {
    try {
      const stored = localStorage.getItem('astral-map-id');
      return stored && Object.hasOwn(MAPS, stored) ? stored as MapId : 'umbra-station';
    } catch {
      return 'umbra-station';
    }
  }

  private stunEnabled(): boolean {
    return this.root.querySelector<HTMLInputElement>('#stun-toggle')?.checked ?? false;
  }

  private async copyFrom(selector: string): Promise<void> {
    const field = this.root.querySelector<HTMLTextAreaElement>(selector);
    if (!field?.value) return;
    try {
      await navigator.clipboard.writeText(field.value);
    } catch {
      field.select();
      document.execCommand('copy');
    }
    this.showToast('Código copiado.');
  }

  private reportError(error: unknown): void {
    const message = error instanceof P2PNetworkError ? error.message : error instanceof Error ? error.message : 'Ha ocurrido un error inesperado.';
    this.showToast(message);
    console.error(error);
  }

  private showConnectionLost(): void {
    if (!this.gameViewActive) return;
    const result = this.root.querySelector<HTMLElement>('#match-result');
    result?.classList.remove('hidden');
    this.setText('#result-title', 'CONEXIÓN PERDIDA');
    this.setText('#result-subtitle', 'El navegador anfitrión ya no está disponible. Esta sesión P2P no migra de host.');
    if (document.pointerLockElement) document.exitPointerLock();
  }

  private showToast(message: string): void {
    const toast = this.root.querySelector<HTMLElement>('#toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('visible');
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => toast.classList.remove('visible'), 3600);
  }

  private destroySession(): void {
    this.sessionGeneration += 1;
    this.gameViewActive = false;
    this.audio.stopAnnouncements();
    cancelAnimationFrame(this.animationFrame);
    this.input?.dispose();
    this.renderer?.dispose();
    this.network?.close();
    this.input = null;
    this.renderer = null;
    this.network = null;
    this.simulation = null;
    this.remoteInputBuffer.clear();
    this.localPlayerPrediction.reset();
    this.currentState = null;
    this.role = null;
    this.localPlayerId = null;
    this.lastInput = null;
    this.inputSequence = 0;
    this.accumulator = 0;
    this.snapshotTimer = 0;
    this.guestSnapshotTimer = 0;
    this.guestSnapshotInterval = 0.05;
    this.lastGuestSnapshotAt = 0;
    this.pingTimer = 0;
    this.latency = 0;
    this.networkStatus = 'connecting';
    this.lastDamageEvent = 0;
    this.lastDamageScannedEvent = 0;
    this.lastLocalGrounded = null;
    this.lastLocalVerticalVelocity = 0;
    this.sniperZoomLevel = 0;
    this.lastPresentedEvent = 0;
    this.activeAlerts = [];
    this.lastAnnouncement = { message: '', at: 0 };
    this.pendingAnnouncement = null;
    this.nextTacticalHudAt = 0;
    this.eventFeedSequence = -1;
    this.eventFeedFirstId = -1;
    this.eventFeedLength = -1;
    this.eventFeedPlayerCount = -1;
    this.interactionPromptAction = '';
    this.interactionPromptLabel = '';
    this.interactionPromptDetail = '';
    this.displayedTimeSeconds = -1;
    this.lastFrameErrorAt = 0;
    window.clearTimeout(this.damageHudTimer);
    this.damageHudTimer = 0;
    window.clearTimeout(this.toastTimer);
    this.toastTimer = 0;
    this.elementCache.clear();
    this.tacticalStateCache = null;
    for (const id in this.tacticalPlayerCache) delete this.tacticalPlayerCache[id];
    if (document.pointerLockElement) document.exitPointerLock();
  }

  private handleGlobalKeyDown = (event: KeyboardEvent): void => {
    if (event.code === 'Tab' && this.gameViewActive) {
      event.preventDefault();
      this.root.querySelector('#scoreboard')?.classList.add('visible');
    }
    if (event.code === 'KeyZ' && this.gameViewActive && !event.repeat) {
      event.preventDefault();
      this.toggleSniperZoom();
    }
    if (event.code === 'Escape' && this.gameViewActive && !document.pointerLockElement) this.root.querySelector('#pause-panel')?.classList.remove('hidden');
  };

  /**
   * Digital combat edges are sent immediately in addition to the fixed input
   * stream. This preserves quick taps and the release between two semi-auto
   * shots over the ordered WebRTC data channel.
   */
  private sendGuestInputEdge(): void {
    if (this.role !== 'guest' || !this.gameViewActive || !this.network || !this.input || !this.localPlayerId) return;
    // This is an event edge rather than a simulation tick. A zero look delta
    // avoids integrating gamepad aim twice, and the command is not replayed as
    // an extra movement step immediately. Prediction consumes one queued edge
    // on its next fixed tick, matching the authoritative input buffer.
    const input = this.input.sample(++this.inputSequence, 0);
    this.lastInput = input;
    if (this.currentState) {
      this.localPlayerPrediction.observeEdge(this.currentState, this.localPlayerId, input);
      this.localPlayerPrediction.setLook(this.currentState, this.localPlayerId, input);
      this.localPlayerPrediction.applyTo(this.currentState, this.localPlayerId, 0);
    }
    if (this.network.isPeerConnected('host')) {
      this.network.sendToHost({ kind: 'input', input });
    }
  }

  /**
   * Keeps every digital transition alive for at least one authoritative tick.
   * A DOWN and UP can otherwise arrive in the same 16 ms window and overwrite
   * each other before the host simulation observes either edge.
   */
  private queueRemoteInput(peerId: string, input: PlayerInput): void {
    this.remoteInputBuffer.push(peerId, input);
  }

  private applyRemoteInputsForTick(): void {
    if (!this.simulation) return;
    for (const peerId of this.remoteInputBuffer.peerIds()) {
      const next = this.remoteInputBuffer.next(peerId);
      if (next) this.simulation.setInput(peerId, next);
    }
  }

  private handleGlobalKeyUp = (event: KeyboardEvent): void => {
    if (event.code === 'Tab') this.root.querySelector('#scoreboard')?.classList.remove('visible');
  };

  private required<T extends Element>(selector: string): T {
    const element = this.query<T>(selector);
    if (!element) throw new Error(`Falta el elemento requerido: ${selector}`);
    return element;
  }

  private query<T extends Element>(selector: string): T | null {
    const cached = this.elementCache.get(selector);
    // Every internal root replacement clears this map first (or goes through
    // destroySession), so a hit is valid for the lifetime of the current view.
    if (cached) return cached as T;
    const element = this.root.querySelector<T>(selector);
    if (element) this.elementCache.set(selector, element);
    else this.elementCache.delete(selector);
    return element;
  }

  private setMarkup(element: HTMLElement, markup: string): void {
    if (this.markupCache.get(element) === markup) return;
    this.markupCache.set(element, markup);
    element.innerHTML = markup;
  }

  private setText(selector: string, value: string): void {
    const element = this.query<HTMLElement>(selector);
    if (element && element.textContent !== value) element.textContent = value;
  }

  private setWidth(selector: string, percentage: number): void {
    const element = this.query<HTMLElement>(selector);
    if (!element) return;
    const clamped = clamp(percentage, 0, 100);
    if (this.widthCache.get(element) === clamped) return;
    this.widthCache.set(element, clamped);
    element.style.width = `${clamped}%`;
  }
}
