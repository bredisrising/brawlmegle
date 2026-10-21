import { config } from '../config';
import type { ForgedFighter } from '../types';
import { scanPoses, type PoseStream, type ScanCaptureOptions, type ScanUpdate } from './scan';

/**
 * Forge client: 3 scan frames + name -> forged fighter.
 *
 * Capture runs on whichever laptop tracks the player. A client laptop sends its
 * frames to the host over P2P; only the host talks to the forge server and keeps fighters.
 * API keys live on the forge server, never in the browser.
 *
 *   POST /api/forge      { name, frames: [front, left, right] }  ->  { id, ownerKey, deleteCode }
 *   GET  /api/forge/:id  ->  ForgedFighter
 *   POST /api/fighters/:id/delete { key } / POST /api/fighters/delete { code }  ->  { ok, id, name }
 *
 * With config.forgeApi empty, the forge calls are mocked. Without a camera (mock input), so is the scan.
 */

/** JPEG data URLs; '' where the scan didn't get that angle. The forge takes whichever are present. */
export type ScanFrames = [front: string, left: string, right: string];

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs while the player turns 360° in front of their camera (~10 s, gives up at ~15 s with what it has).
 * Needs the camera's video and its pose frames (CameraSource has both); without them it returns a mock scan.
 */
export async function captureScan(
  video: HTMLVideoElement | undefined,
  poses?: PoseStream,
  onProgress?: (update: ScanUpdate) => void,
  options?: ScanCaptureOptions,
): Promise<ScanFrames> {
  if (!video || !poses) {
    await wait(800);
    return ['', '', ''];
  }
  const { frames } = await scanPoses(video, poses, onProgress, options);
  return [frames.front ?? '', frames.left ?? '', frames.right ?? ''];
}

const trimSlash = (url: string) => url.replace(/\/+$/, '');

async function errorText(res: Response) {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? res.statusText;
  } catch {
    return res.statusText;
  }
}

/**
 * Usernames are a light "log in": case-insensitive, 1–24 letters, digits, `_ . -`. Null if not usable.
 * All dots is out: `/api/profiles/..` collapses to `/api/` in the URL, so that profile could never be found.
 */
export function normalizeUsername(raw: string): string | null {
  const u = raw.trim().toLowerCase();
  return /^[a-z0-9_.-]{1,24}$/.test(u) && !/^\.+$/.test(u) ? u : null;
}

/** The fighter saved under a username on the forge server, if any (null when none, or with no server). */
export async function findProfile(username: string, api = config.forgeApi, timeoutMs = 4000): Promise<ForgedFighter | null> {
  const u = normalizeUsername(username);
  if (!api || !u) return null;
  // Bounded, so the name screen never waits forever on a hung request before it lets you scan.
  const res = await fetch(`${trimSlash(api)}/api/profiles/${encodeURIComponent(u)}`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) return null;
  const body = (await res.json()) as { fighter: Record<string, unknown> | null };
  return body.fighter ? toForgedFighter(body.fighter) : null;
}

/** Null if the forge server would take a scan right now, else why not (busy, over its limits). Unreachable: null. */
export async function forgeBusy(api = config.forgeApi): Promise<string | null> {
  if (!api) return null;
  try {
    const res = await fetch(`${trimSlash(api)}/api/capacity`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null; // an older server without the endpoint: find out at submit
    const body = (await res.json()) as { ok?: boolean; error?: string };
    return body.ok === false ? body.error ?? 'the forge is busy' : null;
  } catch {
    return null;
  }
}

/**
 * Gets the forge's GPU box up ahead of a likely scan: it powers off after 15 idle minutes and takes about a minute to
 * boot, so asking early hides that behind the username, the scan and the 2D art. Fire and forget.
 */
export function wakeForge(api = config.forgeApi) {
  if (!api) return;
  fetch(`${trimSlash(api)}/api/capacity`, { signal: AbortSignal.timeout(4000) }).catch(() => {});
}

/**
 * "Delete my fighter" (forge/owner.js): the forge hands these out once, when it starts. The browser that scanned keeps
 * the key (roster.ts saveOwner); the code is shown once the forge is done, to screenshot.
 */
export type ForgeOwner = { id: string; key: string; code: string };

/** Starts a forge. Returns its id. `api` defaults to config.forgeApi (empty = mock). */
export async function submitForge(name: string, frames: ScanFrames, api = config.forgeApi, username?: string, timeoutMs = 45_000): Promise<string> {
  return (await startForge(name, frames, api, username, timeoutMs)).id;
}

/** submitForge, plus the owner key and delete code (null from an older forge that doesn't issue them). */
export async function startForge(name: string, frames: ScanFrames, api = config.forgeApi, username?: string, timeoutMs = 45_000): Promise<{ id: string; owner: ForgeOwner | null }> {
  if (!api) {
    await wait(300);
    const id = `mock-${Date.now()}`;
    return { id, owner: { id, key: 'mock', code: mockCode() } };
  }
  const present = frames.filter(Boolean);
  if (present.length === 0) throw new Error('The scan got no frames: nobody was in view');
  // Bounded: a stalled upload would otherwise leave the player on "Forging fighter" with no way back.
  const res = await fetch(`${trimSlash(api)}/api/forge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forge-key': config.forgeKey },
    body: JSON.stringify({ name, username, frames: present, ...(config.forgeQuality ? { quality: config.forgeQuality } : {}) }),
    signal: AbortSignal.timeout(timeoutMs),
  }).catch((err: Error) => {
    throw new Error(`Couldn't reach the forge: ${err.message}`);
  });
  if (!res.ok) throw new Error(`Forge rejected the scan (${res.status}): ${await errorText(res)}`);
  const body = (await res.json()) as { id: string; ownerKey?: unknown; deleteCode?: unknown };
  const owner = typeof body.ownerKey === 'string' && typeof body.deleteCode === 'string' ? { id: body.id, key: body.ownerKey, code: body.deleteCode } : null;
  return { id: body.id, owner };
}

/** Crockford base32, as the forge writes delete codes: no I, L, O or U. */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A made-up code for the mocked forge, so the screens show one. */
function mockCode() {
  const chars = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => CODE_ALPHABET[b & 31]).join('');
  return chars.match(/.{4}/g)!.join('-');
}

/** What the player typed or pasted, as a delete code reads (XXXX-XXXX-XXXX-XXXX, I/L as 1, O as 0), up to 16 characters. */
export function formatDeleteCode(raw: string): string {
  const chars = raw.toUpperCase().replace(/[IL]/g, '1').replace(/O/g, '0').split('').filter((c) => CODE_ALPHABET.includes(c)).join('').slice(0, 16);
  return chars.match(/.{1,4}/g)?.join('-') ?? '';
}

export const isDeleteCode = (code: string) => formatDeleteCode(code).replace(/-/g, '').length === 16;

/** How a delete went: `gone` = the forge no longer has that fighter (deleted now, or before). */
export type DeleteResult = { ok: true; id: string; name: string } | { ok: false; gone: boolean; error: string };

/**
 * Deletes a fighter for good (photos, sheet, card, 3D model, record, highlights), with the owner key this browser
 * kept or the delete code from the screenshot. Never throws. With no forge (mock), there's nothing to delete remotely.
 */
export async function deleteFighter(by: { id: string; key: string } | { code: string }, api = config.forgeApi): Promise<DeleteResult> {
  if (!api) {
    await wait(300);
    return 'id' in by ? { ok: true, id: by.id, name: '' } : { ok: false, gone: false, error: 'No forge server to delete from' };
  }
  const url = 'id' in by ? `${trimSlash(api)}/api/fighters/${encodeURIComponent(by.id)}/delete` : `${trimSlash(api)}/api/fighters/delete`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forge-key': config.forgeKey },
      body: JSON.stringify('id' in by ? { key: by.key } : { code: by.code }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      const body = (await res.json()) as { id?: string; name?: string };
      return { ok: true, id: String(body.id ?? ('id' in by ? by.id : '')), name: String(body.name ?? '') };
    }
    return { ok: false, gone: res.status === 404, error: res.status === 429 ? 'Too many tries. Wait a few minutes and try again.' : await errorText(res) };
  } catch (err) {
    return { ok: false, gone: false, error: `Couldn't reach the forge: ${(err as Error).message}` };
  }
}

const STEPS: readonly NonNullable<ForgedFighter['step']>[] = ['brief', 'sheet', 'model', 'cleanup', 'rig'];
const STATUSES: readonly ForgedFighter['status'][] = ['scanning', 'forging', 'ready', 'failed'];

/** Server JSON -> ForgedFighter. Unknown fields are dropped; `name` falls back to what the player typed. */
export function toForgedFighter(raw: Record<string, unknown>, fallbackName = ''): ForgedFighter {
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const status = STATUSES.includes(raw.status as ForgedFighter['status']) ? (raw.status as ForgedFighter['status']) : 'forging';
  const step = STEPS.includes(raw.step as ForgedFighter['step'] & string) ? (raw.step as ForgedFighter['step']) : undefined;
  const fighter: ForgedFighter = { id: String(raw.id ?? ''), name: str(raw.name) ?? fallbackName, status };
  if (step) fighter.step = step;
  for (const key of ['glbUrl', 'cardUrl', 'sheetUrl', 'error', 'sheetPartialUrl', 'previewVoxelsUrl', 'previewMeshUrl'] as const) {
    const value = str(raw[key]);
    if (value) fighter[key] = value;
  }
  if (raw.brief && typeof raw.brief === 'object') fighter.brief = raw.brief as Record<string, unknown>;
  return fighter;
}

/** One status check. `api` defaults to config.forgeApi (empty = mock: ready right away). */
export async function getForge(id: string, name: string, api = config.forgeApi, signal?: AbortSignal): Promise<ForgedFighter> {
  if (!api) {
    await wait(1200);
    return { id, name, status: 'ready' };
  }
  const res = await fetch(`${trimSlash(api)}/api/forge/${encodeURIComponent(id)}`, { signal });
  if (!res.ok) throw new Error(`Forge status failed (${res.status}): ${await errorText(res)}`);
  return toForgedFighter((await res.json()) as Record<string, unknown>, name);
}

export type ForgeOptions = {
  api?: string;
  pollMs?: number;
  /** Give up and report 'failed' after this long (SPEC fallback ladder: 5 minutes). */
  timeoutMs?: number;
  /** One status check that takes longer than this counts as a failed poll (a stalled request never resolves). */
  requestTimeoutMs?: number;
  signal?: AbortSignal;
  /** Saves the fighter under this username on the server. */
  username?: string;
  /** The owner key and delete code, as soon as the forge has started (once; not from an older forge server). */
  onOwner?: (owner: ForgeOwner) => void;
};

/**
 * Submit + poll until the fighter is ready or failed. `onProgress` gets every status update (step badges).
 * Throws only if the submit fails; once it's running, problems come back as status 'failed' with an error.
 * A ready fighter may have no glbUrl yet (no 3D step): the game then uses its default model.
 */
export async function forgeFighter(
  name: string,
  frames: ScanFrames,
  onProgress?: (fighter: ForgedFighter) => void,
  { api = config.forgeApi, pollMs = 1500, timeoutMs = 5 * 60_000, requestTimeoutMs = 10_000, signal, username, onOwner }: ForgeOptions = {},
): Promise<ForgedFighter> {
  const { id, owner } = await startForge(name, frames, api, username);
  if (owner) onOwner?.(owner);
  const started = Date.now();
  let last: ForgedFighter = { id, name, status: 'scanning' };
  onProgress?.(last);
  let errors = 0;
  for (;;) {
    if (signal?.aborted) throw signal.reason;
    try {
      last = await getForge(id, name, api, requestSignal(requestTimeoutMs, signal));
      errors = 0;
      onProgress?.(last);
      if (last.status === 'ready' || last.status === 'failed') return last;
    } catch (err) {
      if (signal?.aborted) throw signal.reason;
      // A dropped request or two is fine; the forge keeps running server-side.
      if (++errors >= 5) return { ...last, status: 'failed', error: String((err as Error).message ?? err) };
    }
    if (Date.now() - started > timeoutMs) return { ...last, status: 'failed', error: 'Forge timed out' };
    // Back off while the server is unreachable (flaky venue Wi-Fi), so a short outage doesn't fail the fighter.
    await wait(Math.min(pollMs * 2 ** errors, 15_000));
  }
}

/** Per-request timeout, also cancelled by the caller's signal. */
function requestSignal(timeoutMs: number, outer?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return outer && typeof AbortSignal.any === 'function' ? AbortSignal.any([timeout, outer]) : timeout;
}
