import { opponentOf } from '../types';
import type { AttackMove, Command, PlayerId } from '../types';
import type { Intent } from '../intent/intents';
import type { FightEngine } from './FightEngine';
import { FIGHT, MOVES } from './moves';

/**
 * Intent + fight situation -> the move that actually happens. The player says "right arm, straight, fast";
 * the resolver decides it's a lunging cross because the opponent is out of range, or a knee instead of a kick
 * because they're in close. Players never need to know technique: the context makes it look intentional.
 *
 * Rules are a short list so they're easy to read and extend. Each strike intent becomes one attack command.
 */

const MAX_LUNGE = FIGHT.maxLunge;

export class Resolver {
  resolve(player: PlayerId, intents: Intent[], engine: FightEngine): Command[] {
    const commands: Command[] = [];
    for (const intent of intents) {
      const command = this.one(player, intent, engine);
      if (command) commands.push(command);
    }
    return commands;
  }

  private one(player: PlayerId, intent: Intent, engine: FightEngine): Command | null {
    switch (intent.kind) {
      case 'anticipate':
        return intent.limb === 'armL' || intent.limb === 'armR'
          ? { kind: 'anticipate', player, t: intent.t, hand: intent.limb === 'armL' ? 'L' : 'R' }
          : null;
      case 'duck':
        return { kind: 'defend', player, t: intent.t, move: 'duck' };
      case 'dodge':
        return { kind: 'defend', player, t: intent.t, move: 'slip', dir: intent.dir };
      case 'guard':
        return intent.up ? { kind: 'defend', player, t: intent.t, move: 'block' } : null;
      case 'strike':
        return this.strike(player, intent, engine);
      default:
        // jump: no aerial moves yet. cancel: the director handles it.
        return null;
    }
  }

  private strike(player: PlayerId, intent: Extract<Intent, { kind: 'strike' }>, engine: FightEngine): Command {
    const distance = engine.distance();
    const opponent = engine.state(opponentOf(player));
    const arm = intent.limb === 'armL' || intent.limb === 'armR';
    const hand = intent.limb.endsWith('L') ? 'L' : 'R';

    let move: AttackMove;
    if (!arm) {
      // Legs: a knee up close, a kick from range, whatever the leg actually did.
      move = distance < 0.6 ? 'knee' : 'kick';
    } else if (intent.style === 'hook') {
      move = 'hook';
    } else if (intent.style === 'upper') {
      // An uppercut from too far out becomes a straight: nobody wants to uppercut air.
      move = distance > MOVES.uppercut.range + MAX_LUNGE ? (hand === 'L' ? 'jab' : 'cross') : 'uppercut';
    } else {
      move = hand === 'L' ? 'jab' : 'cross';
    }

    // Opponent ducking: the next punch comes in low as an uppercut if it can reach.
    if (arm && engine.evading(opponentOf(player)) === 'duck' && distance <= MOVES.uppercut.range + MAX_LUNGE) move = 'uppercut';

    // Out of range: step in during startup so the strike arrives (up to MAX_LUNGE).
    const reach = MOVES[move].range * 0.9;
    const lunge = distance > reach ? Math.min(MAX_LUNGE, distance - reach) : 0;

    return {
      kind: 'attack',
      player,
      t: intent.t,
      move,
      hand,
      height: intent.height === 'high' || opponent.phase === 'hitstun' ? 'head' : 'body',
      speed: intent.speed,
      windup: intent.windup,
      lunge,
      autoLunge: true,
    };
  }
}
