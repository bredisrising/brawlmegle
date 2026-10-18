import { config } from '../config';
import type { PlayerId } from '../types';

/**
 * Highlights: K.O. replays recorded on the laptop that ran the fight (game/HighlightRecorder.ts), kept by the forge
 * server (POST/GET /api/highlights, newest ~40) and shown as the reel on the title screen.
 */
export type HighlightSide = { id?: string; name: string; cpu?: boolean };

/** What the recorder knows about a K.O. (sent with the clip; the server validates and stamps the time). */
export type HighlightMeta = {
  p1: HighlightSide;
  p2: HighlightSide;
  winner: PlayerId;
  /** The finishing move ("uppercut", "fireball", ...). */
  move: string;
  /** Hits in the winner's combo that ended it (1 = a single hit). */
  combo: number;
  /** Seconds into the round when it ended. */
  roundTime: number;
  /** Clip length, seconds. */
  duration: number;
};

export type Highlight = HighlightMeta & { id: string; url: string; createdAt: number; bytes: number };

const api = () => config.forgeApi.replace(/\/+$/, '');

/** The newest highlights first; [] when the server is unreachable or has none. */
export async function fetchHighlights(signal?: AbortSignal): Promise<Highlight[]> {
  if (!config.forgeApi) return [];
  try {
    const res = await fetch(`${api()}/api/highlights`, { signal });
    if (!res.ok) return [];
    const body = (await res.json()) as { highlights?: Highlight[] };
    return Array.isArray(body.highlights) ? body.highlights.filter((h) => h && typeof h.url === 'string') : [];
  } catch {
    return [];
  }
}

/** Upload one clip. Resolves false (never throws) when it didn't land: a highlight is a bonus, not part of the match. */
export async function uploadHighlight(video: Blob, meta: HighlightMeta): Promise<boolean> {
  if (!config.forgeApi) return false;
  try {
    const res = await fetch(`${api()}/api/highlights`, {
      method: 'POST',
      headers: {
        'content-type': video.type.split(';')[0] || 'video/webm',
        'x-forge-key': config.forgeKey,
        // Names can be any text: URI-encoded so the header stays ASCII.
        'x-highlight-meta': encodeURIComponent(JSON.stringify(meta)),
      },
      body: video,
    });
    if (!res.ok) console.warn('highlight upload failed:', res.status, await res.text().catch(() => ''));
    return res.ok;
  } catch (err) {
    console.warn('highlight upload failed:', err);
    return false;
  }
}

/** "RICO K.O.s DYLAN" and friends, for captions. */
export function headline(h: Pick<HighlightMeta, 'p1' | 'p2' | 'winner'>) {
  const loser = h.winner === 'p1' ? 'p2' : 'p1';
  return { winner: h[h.winner].name, loser: h[loser].name };
}

/** "UPPERCUT", "FLYING KNEE"... from the engine's move id. */
export function moveLabel(move: string) {
  return move.replace(/[_-]+/g, ' ').toUpperCase();
}
