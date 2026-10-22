import { config } from '../config';
import type { ForgedFighter } from '../types';
import { normalizeUsername, toForgedFighter, type ForgeOwner, type OwnerProof } from './forge';
import { forgetRecord } from './leaderboard';

/**
 * The "memory card": fighters saved from earlier scans, for "Choose existing".
 *
 * With a forge server (config.forgeApi), its ready fighters (GET /api/fighters) come first, then
 * anything saved in this browser's localStorage that the server doesn't have, then the house fighters.
 * Without one it's localStorage + house fighters. The client gets the host's list over P2P (`roster`).
 */

const KEY = 'brawlegle.roster';
/**
 * Owner keys for fighters scanned in this browser ("Delete my fighter"), by fighter id: { key, name, createdAt }.
 * Next to the saved fighters but apart from them, so a key never travels with a fighter (P2P roster, picks).
 */
const OWNED_KEY = 'brawlegle.owned';

/** A fighter this browser can delete. */
export type OwnedFighter = { id: string; key: string; name: string; createdAt: number };

/** Built-in fighters are available without scanning or saving to localStorage. */
const HOUSE_FIGHTERS: ForgedFighter[] = [
  { id: 'default', name: 'default', status: 'ready', glbUrl: `${import.meta.env.BASE_URL}models/default.glb` },
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
  const server = await fetchServerFighters(api);
  // The server's list is the truth for forged fighters: one per username (a rescan replaces your fighter), minus the
  // hidden ones. A forged fighter saved in this browser that the server no longer lists (replaced, hidden) or that
  // shares a listed name doesn't come back. Offline (empty list), the browser's copies are all there is.
  const key = (f: ForgedFighter) => f.name.trim().toLowerCase();
  const names = new Set(server.map(key));
  const ids = new Set(server.map((f) => f.id));
  const forged = (f: ForgedFighter) => Boolean(f.glbUrl?.includes('/api/forge/') || f.cardUrl?.includes('/api/forge/'));
  const saved = readSaved().filter((f) => !names.has(key(f)) && !(server.length && forged(f) && !ids.has(f.id)));
  return mergeRosters(server, saved, HOUSE_FIGHTERS);
}

export function saveFighter(fighter: ForgedFighter) {
  try {
    const saved = readSaved().filter((f) => f.id !== fighter.id);
    localStorage.setItem(KEY, JSON.stringify([fighter, ...saved]));
  } catch {
    // Storage unavailable (private window etc). The fighter still works for this session.
  }
}

function readOwned(): Record<string, OwnedFighter> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(OWNED_KEY) ?? '{}');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Record<string, OwnedFighter> = {};
    for (const [id, v] of Object.entries(raw as Record<string, Record<string, unknown>>)) {
      if (id && v && typeof v.key === 'string' && v.key) {
        out[id] = { id, key: v.key, name: typeof v.name === 'string' ? v.name : '', createdAt: typeof v.createdAt === 'number' ? v.createdAt : 0 };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeOwned(owned: Record<string, OwnedFighter>) {
  try {
    const stored = Object.fromEntries(Object.values(owned).map(({ id, key, name, createdAt }) => [id, { key, name, createdAt }]));
    localStorage.setItem(OWNED_KEY, JSON.stringify(stored));
  } catch {
    // Storage unavailable: the delete code shown after the forge is the way back.
  }
}

/** Keep the owner key of a fighter scanned here (as soon as its forge starts). */
export function saveOwner(owner: Pick<ForgeOwner, 'id' | 'key'>, name: string) {
  writeOwned({ ...readOwned(), [owner.id]: { id: owner.id, key: owner.key, name, createdAt: Date.now() } });
}

/**
 * Fighters claimed on this browser with the code from after their forge ("It's me" on another laptop), by fighter id:
 * { code, username, name }. Apart from owner keys: a code isn't a key, and "Delete my fighter" lists only keys.
 */
const CLAIM_KEY = 'brawlegle.claimed';
type Claim = { id: string; code: string; username: string | null; name: string };

function readClaims(): Record<string, Claim> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(CLAIM_KEY) ?? '{}');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Record<string, Claim> = {};
    for (const [id, v] of Object.entries(raw as Record<string, Record<string, unknown>>)) {
      if (id && v && typeof v.code === 'string' && v.code) {
        out[id] = { id, code: v.code, username: typeof v.username === 'string' ? v.username : null, name: typeof v.name === 'string' ? v.name : '' };
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Remember a fighter claimed here with its code (claimFighter said whose it is). */
export function saveClaim(claim: Claim) {
  try {
    localStorage.setItem(CLAIM_KEY, JSON.stringify({ ...readClaims(), [claim.id]: { code: claim.code, username: claim.username, name: claim.name } }));
  } catch {
    // Storage blocked: it lasts until the page closes (the code still works next time).
  }
}

/**
 * Proof that `fighter` is this player's, or null: the owner key (scanned here) or the code (claimed here), for it or
 * for an earlier fighter under the same username (a rescan elsewhere is still their username).
 */
export function ownerProof(fighter: Pick<ForgedFighter, 'id' | 'username'>): OwnerProof | null {
  const owned = readOwned();
  const claims = readClaims();
  if (owned[fighter.id]) return { id: fighter.id, key: owned[fighter.id].key };
  if (claims[fighter.id]) return { id: fighter.id, code: claims[fighter.id].code };
  const username = fighter.username;
  if (!username) return null;
  const key = Object.values(owned).find((o) => normalizeUsername(o.name) === username);
  if (key) return { id: key.id, key: key.key };
  const claim = Object.values(claims).find((c) => c.username === username);
  return claim ? { id: claim.id, code: claim.code } : null;
}

/**
 * Whether this player may fight as `fighter` for real (rated, records): it's theirs (ownerProof), or nobody's (a house
 * fighter or a bot, with no username). Anyone else's plays as a guest.
 */
export const isMine = (fighter: Pick<ForgedFighter, 'id' | 'username'>) => !fighter.username || ownerProof(fighter) !== null;

/** Fighters this browser holds an owner key for, newest first. */
export function ownedFighters(): OwnedFighter[] {
  return Object.values(readOwned()).sort((a, b) => b.createdAt - a.createdAt);
}

/** A deleted fighter: off this browser's memory card, owner keys and cached records. */
export function forgetFighter(id: string) {
  const owned = readOwned();
  if (owned[id]) {
    delete owned[id];
    writeOwned(owned);
  }
  const claims = readClaims();
  if (claims[id]) {
    delete claims[id];
    try {
      localStorage.setItem(CLAIM_KEY, JSON.stringify(Object.fromEntries(Object.values(claims).map(({ id: c, ...rest }) => [c, rest]))));
    } catch {
      // Storage blocked: nothing was kept.
    }
  }
  try {
    const saved = readSaved();
    if (saved.some((f) => f.id === id)) localStorage.setItem(KEY, JSON.stringify(saved.filter((f) => f.id !== id)));
  } catch {
    // Storage unavailable: nothing was saved here either.
  }
  forgetRecord(id);
}

/** The "No" option on the consent prompt: nobody sits out. */
export const maskedFighter = (name: string): ForgedFighter => ({ id: `masked-${Date.now()}`, name, status: 'ready' });
