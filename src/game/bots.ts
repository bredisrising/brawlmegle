import type { ForgedFighter } from '../types';

const at = (file: string) => `${import.meta.env.BASE_URL}models/bots/${file}`;

/**
 * The matchmaking bots: three made-up characters (forged once from generated photos of nobody real), always labeled
 * as bots. One fills in when nobody else is looking for a fight (Game.botFill), until a person turns up.
 */
export const BOTS: ForgedFighter[] = [
  { id: 'bot-tony', name: 'Tin Can Tony', status: 'ready', glbUrl: at('tony.glb'), cardUrl: at('tony.webp') },
  { id: 'bot-gary', name: 'Gym Rat Gary', status: 'ready', glbUrl: at('gary.glb'), cardUrl: at('gary.webp') },
  { id: 'bot-nana', name: 'Nana Knuckles', status: 'ready', glbUrl: at('nana.glb'), cardUrl: at('nana.webp') },
];

/** A bot other than the last one this player fought. */
export function pickBot(last: string | null): ForgedFighter {
  const fresh = BOTS.filter((b) => b.id !== last);
  return fresh[Math.floor(Math.random() * fresh.length)];
}
