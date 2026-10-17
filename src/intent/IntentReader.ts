import type { Command, PlayerId, PoseFrame, Stance } from '../types';

/**
 * PoseFrames -> what the player meant (Commands + Stance). One per player, runs on the host.
 * The camera reports intent; it never decides a hit.
 *
 * TODO: see SPEC.md "Intent reader" (body units, calibration, trigger table).
 */
export class IntentReader {
  readonly player: PlayerId;

  constructor(player: PlayerId) {
    this.player = player;
  }

  update(_frame: PoseFrame): { commands: Command[]; stance: Stance } {
    return {
      commands: [],
      stance: { player: this.player, guard: true, advance: 0, lean: { x: 0, y: 0 }, tracked: false },
    };
  }
}
