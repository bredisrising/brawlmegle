import { config } from '../config';
import type { ForgedFighter } from '../types';
import { toForgedFighter } from './forge';

/**
 * The "memory card": fighters saved from earlier scans, for "Choose existing".
 *
 * With a forge server (config.forgeApi), its ready fighters (GET /api/fighters) come first, then
 * anything saved in this browser's localStorage that the server doesn't have, then the house fighters.
 * Without one it's localStorage + house fighters. The client gets the host's list over P2P (`roster`).
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
    // Whatever is stored (an older format, a hand edit) must not break the memory card: keep only real entries.
    const saved: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(saved)
      ? saved.filter((f): f is ForgedFighter => !!f && typeof f === 'object' && typeof f.id === 'string' && f.id !== '' && typeof f.name === 'string')
      : [];
  } catch {
    return [];
  }
}

/** Ready fighters on the forge server, newest first. Empty if there's no server or it's unreachable. */
export async function fetchServerFighters(api = config.forgeApi, timeoutMs = 4000): Promise<ForgedFighter[]> {
  if (!api) return [];
  try {
    const res = await fetch(`${api.replace(/\/+$/, '')}/api/fighters`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`${res.status}`);
    const list = (await res.json()) as Record<string, unknown>[];
    return list.map((f) => toForgedFighter(f)).filter((f) => f.id && f.status === 'ready');
  } catch (err) {
    console.warn('forge roster unavailable, using local memory card', err);
    return [];
  }
}

/** Server fighters, then local ones the server doesn't know, then house fighters. First id wins. */
export function mergeRosters(...lists: ForgedFighter[][]): ForgedFighter[] {
  const seen = new Set<string>();
  return lists.flat().filter((f) => !seen.has(f.id) && seen.add(f.id));
}

export async function listFighters(api = config.forgeApi): Promise<ForgedFighter[]> {
  return mergeRosters(await fetchServerFighters(api), readSaved(), HOUSE_FIGHTERS);
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
