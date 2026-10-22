import type { CpuLevel } from '../fight/Cpu';
import type { ForgedFighter } from '../types';

const at = (file: string) => `${import.meta.env.BASE_URL}models/bots/${file}`;

/**
 * The matchmaking bots: three made-up characters (forged once from generated photos of nobody real), always labeled
 * as bots. One fills in when nobody else is looking for a fight (Game.botFill), until a person turns up. Each plays at
 * its own CPU level, and its rating (fixed, on its name plate) says how tough it is. Fights against a bot never move
 * the player's rating: the CPU could be farmed, which is how the old leaderboard got inflated.
 */
export type Bot = { fighter: ForgedFighter; level: CpuLevel; rating: number };

export const BOTS: Bot[] = [
  { fighter: { id: 'bot-tony', name: 'Tin Can Tony', status: 'ready', glbUrl: at('tony.glb'), cardUrl: at('tony.webp') }, level: 'easy', rating: 900 },
  { fighter: { id: 'bot-gary', name: 'Gym Rat Gary', status: 'ready', glbUrl: at('gary.glb'), cardUrl: at('gary.webp') }, level: 'normal', rating: 1050 },
  { fighter: { id: 'bot-nana', name: 'Nana Knuckles', status: 'ready', glbUrl: at('nana.glb'), cardUrl: at('nana.webp') }, level: 'hard', rating: 1200 },
];

/** Bots this close to a player's rating are fair picks. */
const NEAR = 175;

/**
 * A bot for a player rated `rating` (null: not placed yet, so one of the two gentler ones): one near their rating
 * (the closest if none is), and not the one they just fought when there's a choice.
 */
export function pickBot(rating: number | null, last: string | null): Bot {
  const fair = rating === null ? BOTS.filter((b) => b.level !== 'hard') : BOTS.filter((b) => Math.abs(b.rating - rating) <= NEAR);
  const pool = fair.length ? fair : [BOTS.reduce((a, b) => (Math.abs(b.rating - rating!) < Math.abs(a.rating - rating!) ? b : a))];
  const fresh = pool.filter((b) => b.fighter.id !== last);
  const from = fresh.length ? fresh : pool;
  return from[Math.floor(Math.random() * from.length)];
}
