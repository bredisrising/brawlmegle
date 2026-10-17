import type { Command, FightEvent, FighterState, PlayerId, Stance } from '../types';

/**
 * Pure TypeScript fight rules: no Three.js, no React, no randomness, fixed 60 Hz tick.
 * Same commands in -> same fight out, so it's testable and K.O. replays come free.
 *
 * TODO: see SPEC.md "Fight engine" (frame data, range bands, defense, stamina, hit-stop).
 */
export class FightEngine {
  private readonly states: Record<PlayerId, FighterState> = {
    p1: { x: -0.5, hp: 100, stamina: 100, phase: 'idle', frame: 0 },
    p2: { x: 0.5, hp: 100, stamina: 100, phase: 'idle', frame: 0 },
  };

  /** Advance one 60 Hz tick. */
  step(_commands: Command[], _stances: Record<PlayerId, Stance>): FightEvent[] {
    return [];
  }

  state(player: PlayerId): Readonly<FighterState> {
    return this.states[player];
  }

  reset(): void {}
}
