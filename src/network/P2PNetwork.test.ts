import { describe, expect, it, vi } from 'vitest';

import {
  P2PNetwork,
  P2PNetworkError,
  type P2PErrorEvent,
  type P2PRole,
} from './P2PNetwork';

interface PeerFixture {
  readonly id: string;
  readonly connection: RTCPeerConnection;
  channel?: RTCDataChannel;
  disposed: boolean;
}

interface NetworkInternals {
  currentRole: P2PRole | null;
  readonly peers: Map<string, PeerFixture>;
}

interface ChannelFixtureOptions {
  readyState?: RTCDataChannelState;
  bufferedAmount?: number;
  send?: (data: string) => void;
}

const createHostNetwork = <TMessage>(): {
  network: P2PNetwork<TMessage>;
  peers: Map<string, PeerFixture>;
} => {
  const network = new P2PNetwork<TMessage>();
  const internals = network as unknown as NetworkInternals;
  internals.currentRole = 'host';
  return { network, peers: internals.peers };
};

const addPeer = (
  peers: Map<string, PeerFixture>,
  id: string,
  options: ChannelFixtureOptions = {},
) => {
  const send = vi.fn(options.send ?? (() => undefined));
  const channel = {
    readyState: options.readyState ?? 'open',
    bufferedAmount: options.bufferedAmount ?? 0,
    send,
  } as unknown as RTCDataChannel;
  peers.set(id, {
    id,
    connection: {} as RTCPeerConnection,
    channel,
    disposed: false,
  });
  return send;
};

const captureError = (operation: () => void): P2PNetworkError => {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(P2PNetworkError);
    return error as P2PNetworkError;
  }
  throw new Error('Expected the operation to throw');
};

describe('P2PNetwork broadcast encoding', () => {
  it('does not build a lazy message when no peer is eligible', () => {
    const { network, peers } = createHostNetwork<{ value: number }>();
    const closedSend = addPeer(peers, 'peer-closed001', { readyState: 'closed' });
    const backpressuredSend = addPeer(peers, 'peer-blocked01', { bufferedAmount: 101 });
    const createData = vi.fn(() => ({ value: 7 }));

    network.broadcastLazy(createData, { maxBufferedAmount: 100 });

    expect(createData).not.toHaveBeenCalled();
    expect(closedSend).not.toHaveBeenCalled();
    expect(backpressuredSend).not.toHaveBeenCalled();
  });

  it('builds and serializes one payload for every eligible peer', () => {
    const { network, peers } = createHostNetwork<{ value: number }>();
    const firstSend = addPeer(peers, 'peer-first0001');
    const secondSend = addPeer(peers, 'peer-second001');
    const toJSON = vi.fn(() => ({ value: 7 }));
    const createData = vi.fn(() => ({ toJSON }) as unknown as { value: number });

    network.broadcastLazy(createData);

    expect(createData).toHaveBeenCalledTimes(1);
    expect(toJSON).toHaveBeenCalledTimes(1);
    expect(firstSend).toHaveBeenCalledTimes(1);
    expect(secondSend).toHaveBeenCalledTimes(1);
    const firstPayload = firstSend.mock.calls[0]?.[0];
    const secondPayload = secondSend.mock.calls[0]?.[0];
    expect(firstPayload).toBe(secondPayload);
    expect(JSON.parse(firstPayload as string)).toMatchObject({ data: { value: 7 } });
  });

  it('continues broadcasting after one send fails, emits the error, and rethrows it', () => {
    const { network, peers } = createHostNetwork<{ value: number }>();
    const firstSend = addPeer(peers, 'peer-first0001', {
      send: () => { throw new Error('channel send failed'); },
    });
    const secondSend = addPeer(peers, 'peer-second001');
    const errors: P2PErrorEvent[] = [];
    network.on('error', (event) => errors.push(event));

    const thrown = captureError(() => network.broadcast({ value: 7 }));

    expect(thrown.code).toBe('CONNECTION_FAILED');
    expect(firstSend).toHaveBeenCalledTimes(1);
    expect(secondSend).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([{ peerId: 'peer-first0001', error: thrown }]);
  });

  it('rejects cyclic and disappearing root values before sending', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const cases: Array<{ label: string; value: unknown }> = [
      { label: 'undefined', value: undefined },
      { label: 'function', value: () => undefined },
      { label: 'symbol', value: Symbol('message') },
      { label: 'cyclic object', value: cyclic },
    ];

    for (const { label, value } of cases) {
      const { network, peers } = createHostNetwork<unknown>();
      const send = addPeer(peers, 'peer-target001');

      const thrown = captureError(() => network.broadcast(value));

      expect(thrown.code, label).toBe('SERIALIZATION_FAILED');
      expect(send, label).not.toHaveBeenCalled();
    }
  });
});
