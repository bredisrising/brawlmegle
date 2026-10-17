import type { ForgedFighter } from '../types';

/**
 * The "memory card": fighters saved from earlier scans, for "Choose existing".
 *
 * For now this is localStorage on whichever laptop forged them, plus a few house fighters.
 * TODO: store on the forge server (GET /api/fighters) so both laptops see the same list,
 * and the client gets it from the host over P2P (`roster` message).
 */

const KEY = 'brawlegle.roster';

/** Built-in fighters are available without scanning or saving to localStorage. */
const HOUSE_FIGHTERS: ForgedFighter[] = [
  { id: 'default', name: 'default', status: 'ready', glbUrl: `${import.meta.env.BASE_URL}models/default.glb` },
  { id: 'house-1', name: 'Kid Haymaker', status: 'ready' },
  { id: 'house-2', name: 'Big Tuna', status: 'ready' },
  { id: 'house-3', name: 'Sweet Science', status: 'ready' },
];

function readSaved(): ForgedFighter[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]') as ForgedFighter[];
  } catch {
    return [];
  }
}

export async function listFighters(): Promise<ForgedFighter[]> {
  return [...readSaved(), ...HOUSE_FIGHTERS];
}

export function saveFighter(fighter: ForgedFighter) {
  try {
    const saved = readSaved().filter((f) => f.id !== fighter.id);
    localStorage.setItem(KEY, JSON.stringify([fighter, ...saved]));
  } catch {
    // Storage unavailable (private window etc). The fighter still works for this session.
  }
}

/** The "No" option on the consent prompt: nobody sits out. */
export const maskedFighter = (name: string): ForgedFighter => ({ id: `masked-${Date.now()}`, name, status: 'ready' });
