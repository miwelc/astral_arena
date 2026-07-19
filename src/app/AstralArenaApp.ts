import { GameAudio } from '../audio/GameAudio';
import { raycastWorld } from '../game/collision';
import { MAPS } from '../game/map';
import { add, clamp, directionFromAngles, vec3 } from '../game/math';
import { createDefaultConfig, GameSimulation, recommendedScoreLimit, recommendedTimeLimit } from '../game/simulation';
import type { ClientMessage, GameMode, HostMessage, MatchConfig, MatchFormat, MatchState, PlayerInput, Team } from '../game/types';
import { WEAPONS } from '../game/weapons';
import { InputController } from '../input/InputController';
import { isValidMatchState } from '../network/matchStateValidation';
import { P2PNetwork, P2PNetworkError } from '../network/P2PNetwork';
import type { ArenaRenderer } from '../render/ArenaRenderer';
import { presentGameEvents, selectAnnouncementCandidate, type EventPresentation } from './eventPresentation';
import { buildMotionRadarContacts } from './motionRadar';

type WireMessage = ClientMessage | HostMessage;
type SessionRole = 'local' | 'host' | 'guest';

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

const TEAM_LABELS: Record<Team, string> = { aurora: 'Aurora', nova: 'Nova', neutral: 'Libre' };

const escapeHtml = (value: string): string =>
  value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character] ?? character);

const formatTime = (seconds: number): string => {
  const safe = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`;
};

const isTeamMode = (state: MatchState): boolean =>
  state.config.mode !== 'deathmatch' && !(state.config.mode === 'juggernaut' && state.config.format === 'duel');

const isValidPlayerInput = (input: unknown): input is PlayerInput => {
  if (!input || typeof input !== 'object') return false;
  const candidate = input as Partial<PlayerInput>;
  const numbers = [candidate.moveX, candidate.moveZ, candidate.yaw, candidate.pitch];
  const buttons = [candidate.fire, candidate.aim, candidate.jump, candidate.reload, candidate.swap, candidate.melee, candidate.grenade];
  return Number.isSafeInteger(candidate.sequence)
    && (candidate.sequence ?? -1) >= 0
    && numbers.every((value) => typeof value === 'number' && Number.isFinite(value))
    && buttons.every((value) => typeof value === 'boolean');
};

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
  private inputSendTimer = 0;
  private pingTimer = 0;
  private latency = 0;
  private networkStatus: 'connecting' | 'connected' | 'lost' = 'connecting';
  private inputSequence = 0;
  private lastInput: PlayerInput | null = null;
  private selectedFormat: MatchFormat = 'duel';
  private guestName = 'Astronauta';
  private gameViewActive = false;
  private lastDamageEvent = 0;
  private sniperZoomLevel: 0 | 1 = 0;
  private lastPresentedEvent = 0;
  private activeAlerts: Array<{ presentation: EventPresentation; expiresAt: number }> = [];
  private lastAnnouncement = { message: '', at: 0 };
  private pendingAnnouncement: EventPresentation | null = null;
  private nextTacticalHudAt = 0;
  private lastFrameErrorAt = 0;
  private lastInvalidSnapshotAt = Number.NEGATIVE_INFINITY;
  private toastTimer = 0;

  public constructor(private readonly root: HTMLElement) {
    window.addEventListener('keydown', this.handleGlobalKeyDown);
    window.addEventListener('keyup', this.handleGlobalKeyUp);
    this.renderMenu();
  }

  private renderMenu(): void {
    this.destroySession();
    this.root.innerHTML = `
      <main class="menu-shell">
        <div class="menu-sky" aria-hidden="true">
          <div class="distant-planet"></div>
          <div class="ridge ridge-back"></div>
          <div class="ridge ridge-front"></div>
          <div class="stars"></div>
        </div>
        <header class="brand-block">
          <div class="brand-kicker"><span></span> SIMULACIÓN DE COMBATE / CR-07</div>
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

            <div class="field-label">FORMATO</div>
            <div class="format-toggle" role="group" aria-label="Formato de partida">
              <button class="format-option selected" data-format="duel" type="button">
                <span class="format-icon">◈</span><strong>1 V 1</strong><small>DUELO</small>
              </button>
              <button class="format-option" data-format="squads" type="button">
                <span class="format-icon">✦</span><strong>4 V 4</strong><small>ESCUADRAS</small>
              </button>
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
              <div class="map-orbit"><i></i><i></i><i></i><b>CR</b></div>
              <div><span class="eyebrow">ZONA ACTIVA</span><h3>Cresta del Cráter</h3><p>Valle mineral · Torre central · Dos bases</p></div>
            </div>
            <div class="intel-card feature-card">
              <span class="card-number">01</span><div><h3>Combate justo</h3><p>Sin clases ni ventajas. Dos armas, escudos, melee, granadas y pickups disputados.</p></div>
            </div>
            <div class="intel-card feature-card">
              <span class="card-number">02</span><div><h3>Bots de relleno</h3><p>La arena completa automáticamente 2 u 8 plazas, también en una partida totalmente local.</p></div>
            </div>
            <div class="intel-card feature-card">
              <span class="card-number">03</span><div><h3>P2P sin backend</h3><p>El anfitrión simula la partida. Oferta y respuesta se intercambian como códigos copiables.</p></div>
            </div>
            <div class="controls-strip"><kbd>WASD</kbd> MOVER · <kbd>RATÓN</kbd> APUNTAR · <kbd>F</kbd> MELEE · <kbd>G</kbd> GRANADA</div>
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

    this.selectedFormat = 'duel';
    this.root.querySelectorAll<HTMLButtonElement>('.format-option').forEach((button) => {
      button.addEventListener('click', () => {
        this.selectedFormat = button.dataset.format as MatchFormat;
        this.root.querySelectorAll('.format-option').forEach((candidate) => candidate.classList.toggle('selected', candidate === button));
      });
    });
    const modeSelect = this.required<HTMLSelectElement>('#game-mode');
    modeSelect.addEventListener('change', () => {
      const mode = modeSelect.value as GameMode;
      this.required<HTMLElement>('#mode-brief p').textContent = MODE_COPY[mode];
    });
    this.required<HTMLButtonElement>('#local-play').addEventListener('click', () => this.startLocal());
    this.required<HTMLButtonElement>('#host-play').addEventListener('click', () => void this.startHostLobby());
    const joinPanel = this.required<HTMLElement>('#join-panel');
    this.required<HTMLButtonElement>('#join-toggle').addEventListener('click', () => joinPanel.classList.remove('hidden'));
    this.required<HTMLButtonElement>('.modal-close').addEventListener('click', () => joinPanel.classList.add('hidden'));
    this.required<HTMLButtonElement>('#guest-connect').addEventListener('click', () => void this.connectAsGuest());
  }

  private startLocal(): void {
    this.audio.uiConfirm();
    const config = this.readConfig();
    this.role = 'local';
    this.localPlayerId = 'local-player';
    this.simulation = new GameSimulation(config, [{ id: this.localPlayerId, name: config.playerName, kind: 'human' }]);
    this.currentState = this.simulation.state;
    void this.startGameView(this.currentState);
  }

  private async startHostLobby(): Promise<void> {
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
    const maxPlayers = this.simulation?.maxPlayers ?? (state.config.format === 'duel' ? 2 : 8);
    this.root.innerHTML = `
      <main class="lobby-shell">
        <div class="lobby-backdrop"></div>
        <header class="lobby-header">
          <button id="lobby-back" class="icon-button" type="button">←</button>
          <div><span class="eyebrow">SALA P2P / ANFITRIÓN</span><h1>${MODE_LABELS[state.config.mode]} <i>·</i> ${state.config.format === 'duel' ? '1 V 1' : '4 V 4'}</h1></div>
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
      rtcConfiguration: useStun
        ? { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }
        : { iceServers: [] },
    });
    this.network.on('connection', (event) => {
      if (event.status === 'connected') {
        this.networkStatus = 'connected';
        if (this.role === 'guest') {
          this.network?.sendToHost({ kind: 'hello', name: this.guestName, protocol: 1 });
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
        const player = this.simulation.addRemotePlayer(peerId, message.name);
        if (!player) {
          this.network?.sendToPeer(peerId, { kind: 'error', message: 'La arena está completa.' });
          return;
        }
        this.network?.sendToPeer(peerId, { kind: 'welcome', playerId: player.id, config: this.simulation.state.config, protocol: 1 });
        this.network?.sendToPeer(peerId, this.createSnapshot());
        this.updateLobbyRoster();
      } else if (message.kind === 'input') {
        if (isValidPlayerInput(message.input)) this.simulation.setInput(peerId, { ...message.input });
      } else if (message.kind === 'ping') {
        this.network?.sendToPeer(peerId, { kind: 'pong', sentAt: message.sentAt, serverAt: performance.now() });
      }
      return;
    }

    if (this.role === 'guest') {
      if (message.kind === 'welcome') {
        this.localPlayerId = message.playerId;
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
        this.currentState = snapshot;
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
    const { ArenaRenderer } = await import('../render/ArenaRenderer');
    if (!this.gameViewActive) return;
    this.root.innerHTML = `
      <main class="game-shell">
        <div id="scene-host" class="scene-host"></div>
        <div class="hud-vignette"></div>
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
          <div class="control-grid"><span><kbd>WASD</kbd>Mover</span><span><kbd>ESPACIO</kbd>Saltar</span><span><kbd>Q</kbd>Cambiar</span><span><kbd>R</kbd>Recargar</span><span><kbd>F</kbd>Melee</span><span><kbd>G</kbd>Granada</span><span><kbd>RMB</kbd>Apuntar</span><span><kbd>Z / RUEDA</kbd>Zoom sniper</span></div>
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
          this.lastInput = this.input.sample(++this.inputSequence);
          this.simulation.setInput(this.localPlayerId, this.lastInput);
        }
        this.simulation.step(fixed);
        this.accumulator -= fixed;
      }
      this.currentState = this.simulation.state;
      if (this.role === 'host' && this.network) {
        this.snapshotTimer += delta;
        if (this.snapshotTimer >= 0.05) {
          this.snapshotTimer %= 0.05;
          this.network.broadcast(this.createSnapshot(), { maxBufferedAmount: 256 * 1024 });
        }
      }
    } else if (this.role === 'guest' && this.network && this.input && this.localPlayerId) {
      this.inputSendTimer += delta;
      this.lastInput = this.input.sample(++this.inputSequence);
      const presentedPlayer = this.currentState?.players[this.localPlayerId];
      if (presentedPlayer) {
        presentedPlayer.yaw = this.lastInput.yaw;
        presentedPlayer.pitch = this.lastInput.pitch;
      }
      const hostConnected = this.network.connectedPeerIds.includes('host');
      if (hostConnected && this.inputSendTimer >= 1 / 30) {
        this.inputSendTimer %= 1 / 30;
        this.network.sendToHost({ kind: 'input', playerId: this.localPlayerId, input: this.lastInput });
      }
      this.pingTimer += delta;
      if (hostConnected && this.pingTimer >= 2) {
        this.pingTimer = 0;
        this.network.sendToHost({ kind: 'ping', sentAt: performance.now() });
      }
    }

    if (this.currentState && this.renderer) {
      this.renderer.setLocalViewAim(Boolean(this.lastInput?.aim), this.sniperZoomLevel);
      this.renderer.render(this.currentState, this.accumulator / fixed, true);
      this.updateHud(this.currentState);
      this.audio.consume(this.currentState.events, this.localPlayerId);
    }
  }

  private updateHud(state: MatchState): void {
    if (!this.localPlayerId) return;
    const player = state.players[this.localPlayerId];
    if (!player) return;
    const weapon = player.inventory[player.activeWeapon];
    const definition = weapon ? WEAPONS[weapon.id] : null;
    const shieldDenominator = Math.max(100, player.maxShield, player.shield);
    this.setWidth('#shield-bar', player.maxShield === 0 ? 0 : (player.shield / shieldDenominator) * 100);
    this.setWidth('#health-bar', (player.health / 70) * 100);
    this.setText('#shield-value', player.maxShield === 0 ? 'OFF' : String(Math.ceil(player.shield)));
    this.setText('#health-value', String(Math.max(0, Math.ceil(player.health))));
    this.setText('#grenade-value', String(player.grenades));
    this.root.querySelector('#shield-block')?.classList.toggle('disabled', player.maxShield === 0);
    const shieldRecharging = player.alive
      && player.maxShield > 0
      && player.shield < player.maxShield
      && state.elapsed - player.lastDamageAt >= (player.isJuggernaut ? 5 : 4);
    this.root.querySelector('#shield-block')?.classList.toggle('recharging', shieldRecharging);
    if (weapon && definition) {
      this.setText('#weapon-name', definition.label);
      this.setText('#weapon-role', definition.role.toUpperCase());
      this.setText('#ammo-mag', String(weapon.magazine));
      this.setText('#ammo-reserve', String(weapon.reserve));
      this.setText('#reload-state', weapon.reloadTimer > 0 ? `RECARGANDO ${weapon.reloadTimer.toFixed(1)}` : '');
    }
    this.setText('#match-time', formatTime(state.timeRemaining));
    this.setText('#ping-value', this.role === 'guest' && this.networkStatus === 'connected' ? `${this.latency} MS` : '');
    if (this.role === 'guest') this.setText('#net-state', this.networkStatus === 'connected' ? 'P2P' : this.networkStatus === 'lost' ? 'SIN HOST' : 'RECONECTANDO');
    const sniperScoped = Boolean(this.lastInput?.aim && weapon?.id === 'sniper' && player.alive);
    if (!sniperScoped) this.sniperZoomLevel = 0;
    this.input?.setLookSensitivityScale(
      sniperScoped ? (this.sniperZoomLevel === 0 ? 0.24 : 0.12) : 1,
    );
    this.root.querySelector('#scope-overlay')?.classList.toggle('active', sniperScoped);
    this.root.querySelector('#crosshair')?.classList.toggle('scoped', sniperScoped);
    this.setText('#scope-zoom', this.sniperZoomLevel === 0 ? '5×' : '10×');
    const hudNow = performance.now();
    if (hudNow >= this.nextTacticalHudAt) {
      const tacticalState = this.presentedTacticalState(state);
      const tacticalPlayer = tacticalState.players[player.id] ?? player;
      this.updateCombatIdentification(tacticalState, tacticalPlayer, definition?.range ?? 120);
      this.updateMotionRadar(tacticalState);
      this.nextTacticalHudAt = hudNow + 1000 / 30;
    }

    const ranked = Object.values(state.players).sort((a, b) => b.score - a.score || b.kills - a.kills);
    if (isTeamMode(state)) {
      this.setText('#score-left', String(state.teamScores.aurora));
      this.setText('#score-right', String(state.teamScores.nova));
    } else {
      this.setText('#score-left', String(player.score));
      this.setText('#score-right', String(ranked.find((candidate) => candidate.id !== player.id)?.score ?? 0));
    }
    this.setText('#hud-objective', this.objectiveText(state, player.team));

    this.updateEventPresentation(state);

    const rows = this.root.querySelector<HTMLElement>('#scoreboard-rows');
    if (rows) {
      rows.innerHTML = ranked
        .map((candidate) => `<div class="scoreboard-row ${candidate.id === player.id ? 'you' : ''} team-${candidate.team}"><span><i></i>${escapeHtml(candidate.name)}${candidate.kind === 'bot' ? '<small>BOT</small>' : ''}${candidate.isJuggernaut ? '<b>COLOSO</b>' : ''}</span><span>${candidate.score}</span><span>${candidate.kills}</span><span>${candidate.deaths}</span></div>`)
        .join('');
    }

    const countdown = this.root.querySelector<HTMLElement>('#countdown');
    if (countdown) {
      countdown.textContent = state.phase === 'countdown' ? (state.countdown > 0.35 ? String(Math.ceil(state.countdown)) : 'COMBATE') : '';
      countdown.classList.toggle('visible', state.phase === 'countdown');
    }
    const death = this.root.querySelector<HTMLElement>('#death-state');
    if (death) death.innerHTML = player.alive ? '' : `<span>TRAJE FUERA DE SERVICIO</span><b>Reentrada en ${Math.max(0, player.respawnTimer).toFixed(1)}</b>`;

    const damage = state.events.filter((event) => event.type === 'hit' && event.targetId === player.id).at(-1);
    if (damage && damage.id > this.lastDamageEvent) {
      this.lastDamageEvent = damage.id;
      this.renderer?.pulseDamage();
    }

    if (state.phase === 'finished') {
      const result = this.root.querySelector<HTMLElement>('#match-result');
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
    let changed = false;
    const players = Object.fromEntries(Object.entries(state.players).map(([id, player]) => {
      const presented = this.renderer?.getPresentedPlayerPosition(id);
      if (!presented) return [id, player];
      changed = true;
      return [id, { ...player, position: presented }];
    }));
    return changed ? { ...state, players } : state;
  }

  private updateCombatIdentification(
    state: MatchState,
    player: MatchState['players'][string],
    weaponRange: number,
  ): void {
    const crosshair = this.root.querySelector<HTMLElement>('#crosshair');
    const scope = this.root.querySelector<HTMLElement>('#scope-overlay');
    crosshair?.classList.remove('ally', 'enemy');
    scope?.classList.remove('ally', 'enemy');
    if (!player.alive) return;

    const origin = add(player.position, vec3(0, player.height * 0.86, 0));
    const hit = raycastWorld(
      origin,
      directionFromAngles(player.yaw, player.pitch),
      weaponRange,
      MAPS[state.config.mapId],
      Object.values(state.players),
      player.id,
    );
    const target = hit?.playerId ? state.players[hit.playerId] : undefined;
    if (!target) return;
    const relation = isTeamMode(state) && target.team === player.team ? 'ally' : 'enemy';
    crosshair?.classList.add(relation);
    scope?.classList.add(relation);
  }

  private updateMotionRadar(state: MatchState): void {
    if (!this.localPlayerId) return;
    const contacts = buildMotionRadarContacts(state, this.localPlayerId);
    const blips = this.root.querySelector<HTMLElement>('#radar-blips');
    if (blips) {
      const markup = contacts.map((contact) => {
        const left = 50 + contact.x * 44;
        const top = 50 + contact.y * 44;
        return `<i class="radar-blip ${contact.relation} ${contact.elevation} ${contact.revealedBy}" style="left:${left.toFixed(2)}%;top:${top.toFixed(2)}%;opacity:${contact.opacity.toFixed(2)}" title="${escapeHtml(contact.name)}"></i>`;
      }).join('');
      if (blips.innerHTML !== markup) blips.innerHTML = markup;
    }
    const local = state.players[this.localPlayerId];
    const moving = Boolean(local && Math.hypot(local.velocity.x, local.velocity.y, local.velocity.z) >= 0.55);
    this.root.querySelector('#motion-radar')?.classList.toggle('local-moving', moving);
  }

  private updateEventPresentation(state: MatchState): void {
    if (!this.localPlayerId) return;
    const now = performance.now();
    const unseen = presentGameEvents(state.events, state, this.localPlayerId, this.lastPresentedEvent);
    const newestEvent = state.events.at(-1);
    if (newestEvent) this.lastPresentedEvent = Math.max(this.lastPresentedEvent, newestEvent.id);

    for (const presentation of unseen) {
      if (presentation.placement === 'center' || presentation.placement === 'both') {
        this.activeAlerts = this.activeAlerts.filter(
          (alert) => alert.presentation.headline !== presentation.headline,
        );
        this.activeAlerts.push({ presentation, expiresAt: now + presentation.durationMs });
      }
    }
    this.activeAlerts = this.activeAlerts
      .filter((alert) => alert.expiresAt > now)
      .slice(-8);

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

    const center = this.root.querySelector<HTMLElement>('#combat-alerts');
    if (center) {
      const byPriority = [...this.activeAlerts]
        .sort((left, right) => right.presentation.priority - left.presentation.priority || right.presentation.eventId - left.presentation.eventId);
      const newest = [...this.activeAlerts]
        .sort((left, right) => right.presentation.eventId - left.presentation.eventId)[0];
      const visibleAlerts = byPriority.length > 0 ? [byPriority[0]!] : [];
      if (newest && newest !== visibleAlerts[0]) visibleAlerts.push(newest);
      if (visibleAlerts.length < 2 && byPriority[1]) visibleAlerts.push(byPriority[1]);
      const markup = visibleAlerts
        .map(({ presentation }) => `<div class="combat-alert ${presentation.tone}"><strong>${escapeHtml(presentation.headline)}</strong>${presentation.detail ? `<span>${escapeHtml(presentation.detail)}</span>` : ''}</div>`)
        .join('');
      if (center.innerHTML !== markup) center.innerHTML = markup;
    }

    const feedPresentations = presentGameEvents(state.events, state, this.localPlayerId, 0)
      .filter((presentation) => presentation.placement !== 'center')
      .slice(-5)
      .reverse();
    const feed = this.root.querySelector<HTMLElement>('#kill-feed');
    if (feed) {
      const markup = feedPresentations
        .map((presentation) => `<div class="feed-item ${presentation.tone}"><i></i>${escapeHtml(presentation.feedText)}</div>`)
        .join('');
      if (feed.innerHTML !== markup) feed.innerHTML = markup;
    }
  }

  private stepSniperZoom(direction: -1 | 1): void {
    if (!this.localPlayerId || !this.currentState || !this.lastInput?.aim) return;
    const player = this.currentState.players[this.localPlayerId];
    const weapon = player?.inventory[player.activeWeapon];
    if (!player?.alive || weapon?.id !== 'sniper') return;
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
    if (!this.simulation) return { kind: 'error', message: 'Simulación no disponible.' };
    const acknowledgedInputs: Record<string, number> = {};
    for (const player of Object.values(this.simulation.state.players)) acknowledgedInputs[player.id] = player.lastProcessedInput;
    return { kind: 'snapshot', serverTime: performance.now(), acknowledgedInputs, state: this.simulation.snapshot() };
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
    try { localStorage.setItem('astral-player-name', name); } catch { /* Storage can be disabled. */ }
    return createDefaultConfig({
      playerName: name,
      mode,
      format: this.selectedFormat,
      difficulty,
      scoreLimit: recommendedScoreLimit(mode, this.selectedFormat),
      timeLimitSeconds: recommendedTimeLimit(mode, this.selectedFormat),
    });
  }

  private savedName(): string {
    try { return localStorage.getItem('astral-player-name') ?? 'Astronauta'; } catch { return 'Astronauta'; }
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
    this.currentState = null;
    this.role = null;
    this.localPlayerId = null;
    this.lastInput = null;
    this.inputSequence = 0;
    this.latency = 0;
    this.networkStatus = 'connecting';
    this.lastDamageEvent = 0;
    this.sniperZoomLevel = 0;
    this.lastPresentedEvent = 0;
    this.activeAlerts = [];
    this.lastAnnouncement = { message: '', at: 0 };
    this.pendingAnnouncement = null;
    this.nextTacticalHudAt = 0;
    this.lastFrameErrorAt = 0;
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

  private handleGlobalKeyUp = (event: KeyboardEvent): void => {
    if (event.code === 'Tab') this.root.querySelector('#scoreboard')?.classList.remove('visible');
  };

  private required<T extends Element>(selector: string): T {
    const element = this.root.querySelector<T>(selector);
    if (!element) throw new Error(`Falta el elemento requerido: ${selector}`);
    return element;
  }

  private setText(selector: string, value: string): void {
    const element = this.root.querySelector<HTMLElement>(selector);
    if (element && element.textContent !== value) element.textContent = value;
  }

  private setWidth(selector: string, percentage: number): void {
    const element = this.root.querySelector<HTMLElement>(selector);
    if (element) element.style.width = `${clamp(percentage, 0, 100)}%`;
  }
}
