import type { MatchState, PlayerState } from '../game/types';

/**
 * Creates the shallow, ephemeral state view used by synchronous P2P encoding.
 * BotMemory only drives the authoritative host AI and is never consumed by a
 * guest renderer or predictor, so omitting it cuts snapshot payload without
 * changing the host simulation state.
 */
export const networkSnapshotState = (state: MatchState): MatchState => {
  const players: Record<string, PlayerState> = {};
  for (const id in state.players) {
    const player = state.players[id];
    if (!player) continue;
    if (player.bot === undefined) {
      players[id] = player;
      continue;
    }
    const networkPlayer = { ...player };
    delete networkPlayer.bot;
    players[id] = networkPlayer;
  }
  return { ...state, players };
};
