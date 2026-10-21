import type { Command, PlayerId, Stance } from '../types';

/**
 * Online fairness: the client's moves get to the host half a round trip after the player made them, so the host's own
 * player is held back by the same before the engine sees them. Only engine input waits: the fighter's tell and live arm
 * still move at once (anticipate commands pass straight through), so it feels just as quick.
 */
export class FairDelay {
  private held: { commands: Command[]; stance: Stance }[] = [];
  private released: Stance | null = null;

  constructor(private readonly player: PlayerId) {}

  /** Holds this tick's input for `ticks` ticks (0: lets anything still held through, then passes input straight on). */
  apply(commands: Command[], stances: Record<PlayerId, Stance>, ticks: number) {
    if (ticks === 0 && this.held.length === 0) return;
    const mine = (c: Command) => c.player === this.player && c.kind !== 'anticipate';
    this.held.push({ commands: commands.filter(mine), stance: stances[this.player] });
    for (let i = commands.length - 1; i >= 0; i--) if (mine(commands[i])) commands.splice(i, 1);
    while (this.held.length > ticks) {
      const out = this.held.shift()!;
      commands.push(...out.commands);
      this.released = out.stance;
    }
    stances[this.player] = this.released ?? this.held[0]?.stance ?? stances[this.player];
  }

  reset() {
    this.held = [];
    this.released = null;
  }
}
