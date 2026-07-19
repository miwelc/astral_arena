/**
 * Small, dependency-free WebRTC transport for manually signalled matches.
 *
 * The network uses a star topology: the host owns one RTCPeerConnection per
 * guest. Offer and answer codes contain the complete SDP (including gathered
 * ICE candidates), so they can be copied between players without a signalling
 * service.
 *
 * This module deliberately configures no STUN or TURN servers by default. That
 * keeps it serverless, but also means that connectivity depends on the peers'
 * networks being able to establish a direct route (typically the same LAN).
 */

// Version 3 adds selectable authored maps and vertical bot navigation state.
// Keeping this in the signalling/message envelope makes stale cached clients
// fail before entering a lobby they cannot deserialize correctly.
export const P2P_PROTOCOL_VERSION = 3 as const;
export const MAX_HOST_PEERS = 7 as const;
export const HOST_PEER_ID = 'host' as const;
export const DEFAULT_DATA_CHANNEL_LABEL = 'astral-arena-reliable' as const;

const SIGNAL_PROTOCOL = 'astral-arena-p2p';
const MESSAGE_PROTOCOL = 'astral-arena-message';
const DEFAULT_ICE_GATHERING_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_MESSAGE_BYTES = 1_048_576;
const MAX_SIGNAL_CODE_LENGTH = 1_500_000;
const MAX_SDP_LENGTH = 1_000_000;
const MAX_CHANNEL_LABEL_LENGTH = 128;
const PEER_ID_PATTERN = /^peer-[a-zA-Z0-9-]{8,80}$/;

export type P2PRole = 'host' | 'guest';

export type P2PConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'failed'
  | 'closed';

export type P2PErrorCode =
  | 'UNSUPPORTED'
  | 'INVALID_STATE'
  | 'INVALID_SIGNAL'
  | 'SIGNAL_MISMATCH'
  | 'PEER_LIMIT'
  | 'PEER_NOT_FOUND'
  | 'CHANNEL_NOT_OPEN'
  | 'ICE_TIMEOUT'
  | 'NEGOTIATION_FAILED'
  | 'SERIALIZATION_FAILED'
  | 'MESSAGE_TOO_LARGE'
  | 'INVALID_MESSAGE'
  | 'CONNECTION_FAILED';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface P2PNetworkOptions {
  /** Native WebRTC configuration. Defaults to `{ iceServers: [] }`. */
  rtcConfiguration?: RTCConfiguration;
  /** Time allowed for all ICE candidates to be embedded in the SDP. */
  iceGatheringTimeoutMs?: number;
  /** Maximum guests accepted by a host. Must be between 1 and 7. */
  maxPeers?: number;
  /** Label used for the reliable RTCDataChannel. */
  channelLabel?: string;
  /** Maximum encoded application-message size. Defaults to 1 MiB. */
  maxMessageBytes?: number;
}

export interface P2PBroadcastOptions {
  /** Skip peers whose reliable channel already has more bytes queued. */
  maxBufferedAmount?: number;
}

export interface P2PConnectionEvent {
  /** Guest id on the host; `"host"` on a guest. */
  peerId: string;
  status: P2PConnectionStatus;
  role: P2PRole;
  error?: P2PNetworkError;
}

export interface P2PMessageEvent<TMessage> {
  /** Guest id on the host; `"host"` on a guest. */
  peerId: string;
  data: TMessage;
}

export interface P2PErrorEvent {
  peerId?: string;
  error: P2PNetworkError;
}

export interface P2PEventMap<TMessage> {
  connection: P2PConnectionEvent;
  message: P2PMessageEvent<TMessage>;
  error: P2PErrorEvent;
}

export type P2PEventListener<TEvent> = (event: TEvent) => void;

export interface P2PSignalPayload {
  protocol: typeof SIGNAL_PROTOCOL;
  version: typeof P2P_PROTOCOL_VERSION;
  kind: 'offer' | 'answer';
  sessionId: string;
  peerId: string;
  channelLabel: string;
  description: RTCSessionDescriptionInit;
}

export class P2PNetworkError extends Error {
  public readonly code: P2PErrorCode;
  public readonly cause?: unknown;

  public constructor(code: P2PErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'P2PNetworkError';
    this.code = code;
    this.cause = cause;
  }
}

interface PeerRecord {
  readonly id: string;
  readonly connection: RTCPeerConnection;
  channel?: RTCDataChannel;
  lastStatus?: P2PConnectionStatus;
  disposed: boolean;
}

interface MessageEnvelope<TMessage> {
  protocol: typeof MESSAGE_PROTOCOL;
  version: typeof P2P_PROTOCOL_VERSION;
  data: TMessage;
}

type UntypedListener = (event: never) => void;

/**
 * A native WebRTC network with manual, copy/paste signalling.
 *
 * `TMessage` should be JSON-serialisable. Invalid or oversized messages are
 * rejected before they reach a data channel.
 */
export class P2PNetwork<TMessage = JsonValue> {
  private readonly rtcConfiguration: RTCConfiguration;
  private readonly iceGatheringTimeoutMs: number;
  private readonly maxPeers: number;
  private readonly channelLabel: string;
  private readonly maxMessageBytes: number;
  private readonly sessionId = createIdentifier('session');
  private readonly peers = new Map<string, PeerRecord>();
  private readonly listeners = new Map<keyof P2PEventMap<TMessage>, Set<UntypedListener>>([
    ['connection', new Set<UntypedListener>()],
    ['message', new Set<UntypedListener>()],
    ['error', new Set<UntypedListener>()],
  ]);

  private currentRole: P2PRole | null = null;
  private assignedGuestId: string | null = null;
  private remoteSessionId: string | null = null;
  private closed = false;

  public constructor(options: P2PNetworkOptions = {}) {
    this.iceGatheringTimeoutMs = integerInRange(
      options.iceGatheringTimeoutMs ?? DEFAULT_ICE_GATHERING_TIMEOUT_MS,
      1_000,
      300_000,
      'iceGatheringTimeoutMs',
    );
    this.maxPeers = integerInRange(options.maxPeers ?? MAX_HOST_PEERS, 1, MAX_HOST_PEERS, 'maxPeers');
    this.maxMessageBytes = integerInRange(
      options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES,
      1_024,
      16_777_216,
      'maxMessageBytes',
    );
    this.channelLabel = validateChannelLabel(options.channelLabel ?? DEFAULT_DATA_CHANNEL_LABEL);
    this.rtcConfiguration = options.rtcConfiguration
      ? cloneRtcConfiguration(options.rtcConfiguration)
      : { iceServers: [] };
  }

  public get role(): P2PRole | null {
    return this.currentRole;
  }

  /** `"host"` for a host, the assigned guest id for a connected/connecting guest. */
  public get localPeerId(): string | null {
    if (this.currentRole === 'host') {
      return HOST_PEER_ID;
    }

    return this.assignedGuestId;
  }

  public get connectedPeerIds(): readonly string[] {
    return [...this.peers.values()]
      .filter((peer) => peer.channel?.readyState === 'open')
      .map((peer) => peer.id);
  }

  public get isClosed(): boolean {
    return this.closed;
  }

  public on<K extends keyof P2PEventMap<TMessage>>(
    type: K,
    listener: P2PEventListener<P2PEventMap<TMessage>[K]>,
  ): () => void {
    const listeners = this.listeners.get(type);
    if (!listeners) {
      throw new P2PNetworkError('INVALID_STATE', `Unknown event type: ${String(type)}`);
    }

    listeners.add(listener as UntypedListener);
    return () => this.off(type, listener);
  }

  public off<K extends keyof P2PEventMap<TMessage>>(
    type: K,
    listener: P2PEventListener<P2PEventMap<TMessage>[K]>,
  ): void {
    this.listeners.get(type)?.delete(listener as UntypedListener);
  }

  /**
   * Reserves one host slot and returns a copyable base64 offer code.
   * Call once per guest; pending offers count towards the seven-peer limit.
   */
  public async hostCreateOffer(): Promise<string> {
    this.assertUsable();
    this.assertRole('host');

    if (this.peers.size >= this.maxPeers) {
      throw new P2PNetworkError(
        'PEER_LIMIT',
        `The host already has ${this.maxPeers} active or pending peer slots.`,
      );
    }

    const peerId = createIdentifier('peer');
    const peer = this.createPeer(peerId);
    this.peers.set(peerId, peer);
    this.emitConnection(peer, 'connecting');

    try {
      const channel = peer.connection.createDataChannel(this.channelLabel, {
        ordered: true,
      });
      this.attachChannel(peer, channel);

      const offer = await peer.connection.createOffer();
      await peer.connection.setLocalDescription(offer);
      await waitForCompleteIceGathering(peer.connection, this.iceGatheringTimeoutMs);

      const description = requireLocalDescription(peer.connection, 'offer');
      return encodeSignal({
        protocol: SIGNAL_PROTOCOL,
        version: P2P_PROTOCOL_VERSION,
        kind: 'offer',
        sessionId: this.sessionId,
        peerId,
        channelLabel: this.channelLabel,
        description,
      });
    } catch (cause) {
      this.disposePeer(peer, false);
      throw normalizeNegotiationError(cause, `Could not create an offer for ${peerId}.`);
    }
  }

  /**
   * Accepts a host's base64 offer and returns the base64 answer to copy back.
   */
  public async guestAcceptOffer(offerCode: string): Promise<string> {
    this.assertUsable();
    if (this.currentRole === 'host') {
      throw new P2PNetworkError('INVALID_STATE', 'A host cannot accept another host offer.');
    }
    if (this.peers.size > 0 || this.assignedGuestId !== null) {
      throw new P2PNetworkError('INVALID_STATE', 'This guest has already accepted an offer.');
    }

    const signal = decodeSignal(offerCode, 'offer');
    this.currentRole = 'guest';
    this.assignedGuestId = signal.peerId;
    this.remoteSessionId = signal.sessionId;

    const peer = this.createPeer(HOST_PEER_ID);
    this.peers.set(HOST_PEER_ID, peer);
    this.emitConnection(peer, 'connecting');

    peer.connection.ondatachannel = (event): void => {
      if (event.channel.label !== signal.channelLabel) {
        event.channel.close();
        const error = new P2PNetworkError(
          'SIGNAL_MISMATCH',
          `Unexpected data-channel label "${event.channel.label}".`,
        );
        this.emit('error', { peerId: HOST_PEER_ID, error });
        return;
      }

      if (peer.channel && peer.channel !== event.channel) {
        event.channel.close();
        return;
      }

      this.attachChannel(peer, event.channel);
    };

    try {
      await peer.connection.setRemoteDescription(signal.description);
      const answer = await peer.connection.createAnswer();
      await peer.connection.setLocalDescription(answer);
      await waitForCompleteIceGathering(peer.connection, this.iceGatheringTimeoutMs);

      const description = requireLocalDescription(peer.connection, 'answer');
      return encodeSignal({
        protocol: SIGNAL_PROTOCOL,
        version: P2P_PROTOCOL_VERSION,
        kind: 'answer',
        sessionId: signal.sessionId,
        peerId: signal.peerId,
        channelLabel: signal.channelLabel,
        description,
      });
    } catch (cause) {
      this.disposePeer(peer, false);
      this.currentRole = null;
      this.assignedGuestId = null;
      this.remoteSessionId = null;
      throw normalizeNegotiationError(cause, 'Could not accept the host offer.');
    }
  }

  /** Completes the host side of a previously created offer. */
  public async hostAcceptAnswer(answerCode: string): Promise<void> {
    this.assertUsable();
    if (this.currentRole !== 'host') {
      throw new P2PNetworkError('INVALID_STATE', 'Only a host can accept guest answers.');
    }

    const signal = decodeSignal(answerCode, 'answer');
    if (signal.sessionId !== this.sessionId) {
      throw new P2PNetworkError('SIGNAL_MISMATCH', 'This answer belongs to a different host session.');
    }
    if (signal.channelLabel !== this.channelLabel) {
      throw new P2PNetworkError('SIGNAL_MISMATCH', 'The answer uses a different data-channel label.');
    }

    const peer = this.peers.get(signal.peerId);
    if (!peer) {
      throw new P2PNetworkError(
        'PEER_NOT_FOUND',
        `No pending offer exists for peer "${signal.peerId}".`,
      );
    }
    if (peer.connection.currentRemoteDescription) {
      throw new P2PNetworkError('INVALID_STATE', `Peer "${signal.peerId}" already has an answer.`);
    }

    try {
      await peer.connection.setRemoteDescription(signal.description);
    } catch (cause) {
      throw normalizeNegotiationError(cause, `Could not apply the answer for ${signal.peerId}.`);
    }
  }

  /** Sends one reliable message from a guest to its host. */
  public sendToHost(data: TMessage): void {
    this.assertUsable();
    if (this.currentRole !== 'guest') {
      throw new P2PNetworkError('INVALID_STATE', 'Only a guest can use sendToHost().');
    }

    this.sendOnPeer(this.requirePeer(HOST_PEER_ID), data);
  }

  /** Sends one reliable message to every connected guest. */
  public broadcast(data: TMessage, options: P2PBroadcastOptions = {}): void {
    this.assertUsable();
    if (this.currentRole !== 'host') {
      throw new P2PNetworkError('INVALID_STATE', 'Only a host can broadcast to guests.');
    }

    const encoded = this.encodeMessage(data);
    for (const peer of this.peers.values()) {
      if (
        peer.channel?.readyState === 'open' &&
        (options.maxBufferedAmount === undefined || peer.channel.bufferedAmount <= options.maxBufferedAmount)
      ) {
        this.sendEncoded(peer, encoded);
      }
    }
  }

  /** Releases offers that have not received an answer yet. Connected peers are preserved. */
  public cancelPendingOffers(): number {
    this.assertUsable();
    if (this.currentRole !== 'host') {
      throw new P2PNetworkError('INVALID_STATE', 'Only a host can cancel pending offers.');
    }
    let cancelled = 0;
    for (const peer of [...this.peers.values()]) {
      if (peer.connection.currentRemoteDescription || peer.channel?.readyState === 'open') continue;
      this.disposePeer(peer, false);
      cancelled += 1;
    }
    return cancelled;
  }

  /** Sends one reliable message from the host to a connected guest. */
  public sendToPeer(peerId: string, data: TMessage): void {
    this.assertUsable();
    if (this.currentRole !== 'host') {
      throw new P2PNetworkError('INVALID_STATE', 'Only a host can use sendToPeer().');
    }
    if (!PEER_ID_PATTERN.test(peerId)) {
      throw new P2PNetworkError('PEER_NOT_FOUND', 'The supplied peer id is invalid.');
    }

    this.sendOnPeer(this.requirePeer(peerId), data);
  }

  /** Closes every peer connection. Calling close more than once is safe. */
  public close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    for (const peer of [...this.peers.values()]) {
      this.emitConnection(peer, 'closed');
      this.disposePeer(peer, false);
    }
    this.peers.clear();
  }

  private createPeer(peerId: string): PeerRecord {
    const PeerConnection = globalThis.RTCPeerConnection;
    if (typeof PeerConnection !== 'function') {
      throw new P2PNetworkError(
        'UNSUPPORTED',
        'This browser does not provide the native RTCPeerConnection API.',
      );
    }

    let connection: RTCPeerConnection;
    try {
      connection = new PeerConnection(this.rtcConfiguration);
    } catch (cause) {
      throw new P2PNetworkError('UNSUPPORTED', 'Could not create a WebRTC peer connection.', cause);
    }

    const peer: PeerRecord = {
      id: peerId,
      connection,
      disposed: false,
    };

    connection.onconnectionstatechange = (): void => {
      switch (connection.connectionState) {
        case 'new':
          break;
        case 'connecting':
          this.emitConnection(peer, 'connecting');
          break;
        case 'connected':
          if (peer.channel?.readyState === 'open') {
            this.emitConnection(peer, 'connected');
          }
          break;
        case 'disconnected':
          this.emitConnection(peer, 'disconnected');
          break;
        case 'failed': {
          const error = new P2PNetworkError(
            'CONNECTION_FAILED',
            `The WebRTC connection to "${peer.id}" failed.`,
          );
          this.emitConnection(peer, 'failed', error);
          this.emit('error', { peerId: peer.id, error });
          this.disposePeer(peer, false);
          break;
        }
        case 'closed':
          this.emitConnection(peer, 'closed');
          this.disposePeer(peer, false);
          break;
      }
    };

    return peer;
  }

  private attachChannel(peer: PeerRecord, channel: RTCDataChannel): void {
    peer.channel = channel;
    channel.binaryType = 'arraybuffer';

    channel.onopen = (): void => {
      this.emitConnection(peer, 'connected');
    };

    channel.onmessage = (event): void => {
      try {
        const data = this.decodeMessage(event.data);
        this.emit('message', { peerId: peer.id, data });
      } catch (cause) {
        const error =
          cause instanceof P2PNetworkError
            ? cause
            : new P2PNetworkError('INVALID_MESSAGE', 'Received an invalid peer message.', cause);
        this.emit('error', { peerId: peer.id, error });
      }
    };

    channel.onerror = (event): void => {
      const error = new P2PNetworkError(
        'CONNECTION_FAILED',
        `The data channel for "${peer.id}" reported an error.`,
        event,
      );
      this.emit('error', { peerId: peer.id, error });
    };

    channel.onclose = (): void => {
      this.emitConnection(peer, 'closed');
      this.disposePeer(peer, true);
    };
  }

  private sendOnPeer(peer: PeerRecord, data: TMessage): void {
    this.sendEncoded(peer, this.encodeMessage(data));
  }

  private sendEncoded(peer: PeerRecord, encoded: string): void {
    const channel = peer.channel;
    if (!channel || channel.readyState !== 'open') {
      throw new P2PNetworkError(
        'CHANNEL_NOT_OPEN',
        `The reliable channel for peer "${peer.id}" is not open.`,
      );
    }

    try {
      channel.send(encoded);
    } catch (cause) {
      throw new P2PNetworkError(
        'CONNECTION_FAILED',
        `Could not send a message to peer "${peer.id}".`,
        cause,
      );
    }
  }

  private encodeMessage(data: TMessage): string {
    let encoded: string;
    try {
      encoded = JSON.stringify({
        protocol: MESSAGE_PROTOCOL,
        version: P2P_PROTOCOL_VERSION,
        data,
      } satisfies MessageEnvelope<TMessage>);
    } catch (cause) {
      throw new P2PNetworkError(
        'SERIALIZATION_FAILED',
        'Messages must be JSON-serialisable.',
        cause,
      );
    }

    const parsed = safeParseJson(encoded);
    if (!isRecord(parsed) || !Object.prototype.hasOwnProperty.call(parsed, 'data')) {
      throw new P2PNetworkError(
        'SERIALIZATION_FAILED',
        'Messages cannot contain an undefined, function, or symbol root value.',
      );
    }

    if (utf8ByteLength(encoded) > this.maxMessageBytes) {
      throw new P2PNetworkError(
        'MESSAGE_TOO_LARGE',
        `The encoded message exceeds ${this.maxMessageBytes} bytes.`,
      );
    }

    return encoded;
  }

  private decodeMessage(raw: unknown): TMessage {
    if (typeof raw !== 'string') {
      throw new P2PNetworkError('INVALID_MESSAGE', 'Only JSON protocol messages are accepted.');
    }
    if (utf8ByteLength(raw) > this.maxMessageBytes) {
      throw new P2PNetworkError(
        'MESSAGE_TOO_LARGE',
        `The received message exceeds ${this.maxMessageBytes} bytes.`,
      );
    }

    const decoded = safeParseJson(raw);
    if (
      !isRecord(decoded) ||
      decoded.protocol !== MESSAGE_PROTOCOL ||
      decoded.version !== P2P_PROTOCOL_VERSION ||
      !Object.prototype.hasOwnProperty.call(decoded, 'data')
    ) {
      throw new P2PNetworkError('INVALID_MESSAGE', 'The peer message envelope is invalid.');
    }

    return decoded.data as TMessage;
  }

  private requirePeer(peerId: string): PeerRecord {
    const peer = this.peers.get(peerId);
    if (!peer) {
      throw new P2PNetworkError('PEER_NOT_FOUND', `Peer "${peerId}" does not exist.`);
    }
    return peer;
  }

  private assertUsable(): void {
    if (this.closed) {
      throw new P2PNetworkError('INVALID_STATE', 'This P2P network has been closed.');
    }
  }

  private assertRole(role: P2PRole): void {
    if (this.currentRole !== null && this.currentRole !== role) {
      throw new P2PNetworkError(
        'INVALID_STATE',
        `This network is already acting as ${this.currentRole}.`,
      );
    }
    this.currentRole = role;
  }

  private emitConnection(
    peer: PeerRecord,
    status: P2PConnectionStatus,
    error?: P2PNetworkError,
  ): void {
    if (peer.lastStatus === status) {
      return;
    }
    peer.lastStatus = status;

    const role = this.currentRole;
    if (!role) {
      return;
    }

    this.emit('connection', {
      peerId: peer.id,
      status,
      role,
      ...(error ? { error } : {}),
    });
  }

  private emit<K extends keyof P2PEventMap<TMessage>>(type: K, event: P2PEventMap<TMessage>[K]): void {
    const listeners = this.listeners.get(type);
    if (!listeners) {
      return;
    }

    for (const listener of [...listeners]) {
      (listener as (value: P2PEventMap<TMessage>[K]) => void)(event);
    }
  }

  private disposePeer(peer: PeerRecord, channelAlreadyClosed: boolean): void {
    if (peer.disposed) {
      return;
    }
    peer.disposed = true;
    this.peers.delete(peer.id);

    peer.connection.onconnectionstatechange = null;
    peer.connection.ondatachannel = null;

    if (peer.channel) {
      peer.channel.onopen = null;
      peer.channel.onmessage = null;
      peer.channel.onerror = null;
      peer.channel.onclose = null;
      if (!channelAlreadyClosed && peer.channel.readyState !== 'closed') {
        peer.channel.close();
      }
    }

    if (peer.connection.signalingState !== 'closed') {
      peer.connection.close();
    }
  }
}

function validateChannelLabel(label: string): string {
  const trimmed = label.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_CHANNEL_LABEL_LENGTH) {
    throw new P2PNetworkError(
      'INVALID_STATE',
      `channelLabel must contain between 1 and ${MAX_CHANNEL_LABEL_LENGTH} characters.`,
    );
  }
  return trimmed;
}

function integerInRange(value: number, min: number, max: number, name: string): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new P2PNetworkError(
      'INVALID_STATE',
      `${name} must be an integer between ${min} and ${max}.`,
    );
  }
  return value;
}

function cloneRtcConfiguration(configuration: RTCConfiguration): RTCConfiguration {
  return {
    ...configuration,
    ...(configuration.iceServers
      ? {
          iceServers: configuration.iceServers.map((server) => ({
            ...server,
            urls: Array.isArray(server.urls) ? [...server.urls] : server.urls,
          })),
        }
      : {}),
    ...(configuration.certificates ? { certificates: [...configuration.certificates] } : {}),
  };
}

function createIdentifier(prefix: 'peer' | 'session'): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return `${prefix}-${cryptoApi.randomUUID()}`;
  }

  if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    const value = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${prefix}-${value}`;
  }

  const fallback = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${fallback}`;
}

function requireLocalDescription(
  connection: RTCPeerConnection,
  expectedType: 'offer' | 'answer',
): RTCSessionDescriptionInit {
  const description = connection.localDescription;
  if (!description || description.type !== expectedType || !description.sdp) {
    throw new P2PNetworkError(
      'NEGOTIATION_FAILED',
      `WebRTC did not produce a complete ${expectedType} description.`,
    );
  }

  return { type: description.type, sdp: description.sdp };
}

function waitForCompleteIceGathering(
  connection: RTCPeerConnection,
  timeoutMs: number,
): Promise<void> {
  if (connection.iceGatheringState === 'complete') {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = (): void => {
      clearTimeout(timeout);
      connection.removeEventListener('icegatheringstatechange', onGatheringStateChange);
      connection.removeEventListener('connectionstatechange', onConnectionStateChange);
    };

    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve();
    };

    const fail = (error: P2PNetworkError): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    const onGatheringStateChange = (): void => {
      if (connection.iceGatheringState === 'complete') {
        finish();
      }
    };

    const onConnectionStateChange = (): void => {
      if (connection.connectionState === 'closed') {
        fail(new P2PNetworkError('INVALID_STATE', 'The connection closed while gathering ICE.'));
      }
    };

    const timeout = setTimeout(() => {
      fail(
        new P2PNetworkError(
          'ICE_TIMEOUT',
          `ICE gathering did not complete within ${timeoutMs} ms.`,
        ),
      );
    }, timeoutMs);

    connection.addEventListener('icegatheringstatechange', onGatheringStateChange);
    connection.addEventListener('connectionstatechange', onConnectionStateChange);

    // Cover a state transition that happened between the initial check and
    // listener registration.
    onGatheringStateChange();
  });
}

function encodeSignal(signal: P2PSignalPayload): string {
  const json = JSON.stringify(signal);
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  const chunkSize = 0x8000;

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  try {
    return btoa(binary);
  } catch (cause) {
    throw new P2PNetworkError('UNSUPPORTED', 'This browser cannot encode base64 signals.', cause);
  }
}

function decodeSignal(code: string, expectedKind: 'offer' | 'answer'): P2PSignalPayload {
  if (typeof code !== 'string') {
    throw new P2PNetworkError('INVALID_SIGNAL', 'The signalling code must be a base64 string.');
  }

  const compact = code.replace(/\s+/g, '');
  if (
    compact.length === 0 ||
    compact.length > MAX_SIGNAL_CODE_LENGTH ||
    compact.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)
  ) {
    throw new P2PNetworkError('INVALID_SIGNAL', 'The signalling code is not valid base64.');
  }

  let decoded: unknown;
  try {
    const binary = atob(compact);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new P2PNetworkError('INVALID_SIGNAL', 'The signalling code could not be decoded.', cause);
  }

  if (!isRecord(decoded)) {
    throw new P2PNetworkError('INVALID_SIGNAL', 'The decoded signal must be an object.');
  }
  if (decoded.protocol !== SIGNAL_PROTOCOL || decoded.version !== P2P_PROTOCOL_VERSION) {
    throw new P2PNetworkError('INVALID_SIGNAL', 'The signal protocol or version is unsupported.');
  }
  if (decoded.kind !== expectedKind) {
    throw new P2PNetworkError(
      'INVALID_SIGNAL',
      `Expected a ${expectedKind} code but received ${String(decoded.kind)}.`,
    );
  }
  if (typeof decoded.sessionId !== 'string' || !/^session-[a-zA-Z0-9-]{8,80}$/.test(decoded.sessionId)) {
    throw new P2PNetworkError('INVALID_SIGNAL', 'The signal contains an invalid session id.');
  }
  if (typeof decoded.peerId !== 'string' || !PEER_ID_PATTERN.test(decoded.peerId)) {
    throw new P2PNetworkError('INVALID_SIGNAL', 'The signal contains an invalid peer id.');
  }
  if (typeof decoded.channelLabel !== 'string') {
    throw new P2PNetworkError('INVALID_SIGNAL', 'The signal contains an invalid channel label.');
  }
  const channelLabel = validateChannelLabel(decoded.channelLabel);
  const description = validateDescription(decoded.description, expectedKind);

  return {
    protocol: SIGNAL_PROTOCOL,
    version: P2P_PROTOCOL_VERSION,
    kind: expectedKind,
    sessionId: decoded.sessionId,
    peerId: decoded.peerId,
    channelLabel,
    description,
  };
}

function validateDescription(value: unknown, expectedType: 'offer' | 'answer'): RTCSessionDescriptionInit {
  if (!isRecord(value) || value.type !== expectedType || typeof value.sdp !== 'string') {
    throw new P2PNetworkError('INVALID_SIGNAL', `The signal does not contain a valid ${expectedType} SDP.`);
  }
  if (value.sdp.length === 0 || value.sdp.length > MAX_SDP_LENGTH || !value.sdp.startsWith('v=0')) {
    throw new P2PNetworkError('INVALID_SIGNAL', 'The SDP payload is empty, oversized, or malformed.');
  }

  return { type: expectedType, sdp: value.sdp };
}

function normalizeNegotiationError(cause: unknown, fallbackMessage: string): P2PNetworkError {
  if (cause instanceof P2PNetworkError) {
    return cause;
  }
  return new P2PNetworkError('NEGOTIATION_FAILED', fallbackMessage, cause);
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (cause) {
    throw new P2PNetworkError('INVALID_MESSAGE', 'The message is not valid JSON.', cause);
  }
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export default P2PNetwork;
