/**
 * What players do, for the owners' stats page (/stats/) and Google Analytics: the camera allowed, a scan done, a match
 * won against Gary... Each moment goes to GA4 when its tag loaded (index.html) and, batched, to our own server's
 * /api/moments, which ad blockers leave alone, so the stats page's counts are the real ones.
 *
 * No names, usernames, photos or IP addresses: a random id for this page load, the moment, and a few plain facts about
 * it (which bot, how long the scan took, won or lost). Nothing is sent from local dev (`?analytics=1` turns it on) or
 * with `?analytics=0`. A browser that opened the stats page is marked as the owners', and the page leaves it out.
 * Never throws: analytics must not break the game.
 */
import { config } from './config';

export type Moment =
  /** The page opened (where from, which browser), and closed (how long, how many matches). */
  | 'visit'
  | 'leave'
  /** The camera: the first-visit popup shown, allowed, "Not now", or it failed (blocked, no camera, in use). */
  | 'cam_ask'
  | 'cam_on'
  | 'cam_later'
  | 'cam_fail'
  /** A title screen choice: Find a fight, VS CPU, Host, Join, Watch, Training. */
  | 'play'
  /** The fighter they went with (scan, saved, guest, house, masked); a scan's steps; setting up failed. */
  | 'fighter'
  | 'scan_start'
  | 'scan_sent'
  | 'forge_done'
  | 'setup_fail'
  /** Matchmaking: looking, a bot stepped in, a person was found. */
  | 'search'
  | 'bot_in'
  | 'matched'
  /** A match (best of three) started, finished, or was left half way. */
  | 'fight_start'
  | 'match_end'
  | 'match_quit'
  /** After the K.O.: rematch, next opponent, another fighter, back to the title. */
  | 'rematch'
  | 'next'
  | 'change_fighter'
  | 'title'
  /** Something broke: a script error, the camera, the 3D. */
  | 'error';

type Value = string | number | boolean;
export type Params = Record<string, Value | null | undefined>;
type Sent = { n: Moment; t: number; p?: Record<string, Value> };

/** Set by the stats page: this browser is one of ours. */
const OWNER_KEY = 'brawlmegle.owner';
/** This tab's visit id: "Title" reloads the page, and that's still the same visit. Gone when the tab closes. */
const SESSION_KEY = 'brawlmegle.session';
const FLUSH_MS = 10_000;
const MAX_BATCH = 25;
/** Script errors sent per page load: one broken frame loop shouldn't send thousands. */
const MAX_ERRORS = 3;
const MAX_TEXT = 100;

const GA = typeof window !== 'undefined' ? (window as unknown as { gtag?: (...args: unknown[]) => void }) : null;
const queue: Sent[] = [];
const once = new Set<string>();
const marks = new Map<string, number>();
let session = '';
let enabled = false;
let owner = false;
let errors = 0;
let matches = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

/** Records a moment. `params`: a few plain facts (no names), strings cut to 100 characters. */
export function track(name: Moment, params?: Params) {
  try {
    const p = clean(params);
    if (name === 'match_end') matches++;
    // GA4 counts the visit itself (page_view, with its own referrer and device reports).
    if (name !== 'visit') GA?.gtag?.('event', name, p ?? {});
    if (!enabled) return;
    queue.push({ n: name, t: Math.round(performance.now()), ...(p ? { p } : {}) });
    if (queue.length >= MAX_BATCH) flush();
    else timer ??= setTimeout(flush, FLUSH_MS);
  } catch {
    // Never in the game's way.
  }
}

/** track(), at most once per page load (the title screen comes back after every match). */
export function trackOnce(name: Moment, params?: Params) {
  if (once.has(name)) return;
  once.add(name);
  track(name, params);
}

/** Starts a stopwatch (`secsSince` reads it): from looking for an opponent to finding one, a scan to its fighter. */
export function mark(key: string) {
  marks.set(key, performance.now());
}

/** Whole seconds since `mark(key)`, or null when it wasn't marked. */
export function secsSince(key: string): number | null {
  const at = marks.get(key);
  return at === undefined ? null : Math.round((performance.now() - at) / 1000);
}

/** Something broke (`kind`: js, camera, webgl, net...). A short message, never more than a few per page. */
export function trackError(kind: string, message: unknown) {
  if (errors >= MAX_ERRORS) return;
  errors++;
  const text = message instanceof Error ? `${message.name}: ${message.message}` : String(message ?? '');
  track('error', { kind, msg: text });
}

function clean(params?: Params): Record<string, Value> | undefined {
  if (!params) return undefined;
  const out: Record<string, Value> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'number') {
      if (Number.isFinite(v)) out[k] = Math.round(v * 100) / 100;
    } else out[k] = typeof v === 'string' ? v.slice(0, MAX_TEXT) : v;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Sends what's queued. Beacons survive the tab closing; text/plain keeps a cross-origin one (dev) simple. */
function flush() {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!queue.length) return;
  const batch = queue.splice(0, queue.length);
  try {
    const body = JSON.stringify({ s: session, t: Math.round(performance.now()), ...(owner ? { o: 1 } : {}), e: batch });
    const url = `${config.forgeApi}/api/moments`;
    const sent = typeof navigator.sendBeacon === 'function' && navigator.sendBeacon(url, new Blob([body], { type: 'text/plain' }));
    if (!sent) void fetch(url, { method: 'POST', body, keepalive: true, headers: { 'content-type': 'text/plain' } }).catch(() => {});
  } catch {
    // Lost: it's only counting.
  }
}

/** Where the visitor came from, on what: the `visit` moment's facts. */
function visitFacts(returning: boolean): Params {
  const url = new URLSearchParams(location.search);
  let ref = '';
  try {
    const host = document.referrer ? new URL(document.referrer).hostname.replace(/^www\./, '') : '';
    if (host !== location.hostname.replace(/^www\./, '')) ref = host;
  } catch {}
  const ua = navigator.userAgent;
  const os = /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /CrOS/.test(ua) ? 'ChromeOS' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'other';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'other';
  const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const device = touch ? (Math.min(screen.width, screen.height) >= 700 ? 'tablet' : 'phone') : 'computer';
  return {
    ref,
    utm: url.get('utm_source') ?? url.get('ref'),
    camp: url.get('utm_campaign'),
    os,
    browser,
    device,
    returning,
    lang: (navigator.language || '').split('-')[0],
    site: import.meta.env.BASE_URL,
  };
}

/** Whether this browser has been here before: any of the game's saved keys (camera popup, fighters, settings). */
function seenBefore() {
  try {
    for (let i = 0; i < localStorage.length; i++) if (/^brawl(m)?egle\./.test(localStorage.key(i) ?? '')) return true;
  } catch {}
  return false;
}

/** Starts counting this page load: the `visit`, script errors, and the `leave` when the tab goes. Once, at startup. */
export function startAnalytics() {
  try {
    const url = new URLSearchParams(location.search);
    const automated = navigator.webdriver || /Headless/.test(navigator.userAgent);
    enabled = url.get('analytics') === '1' || (!import.meta.env.DEV && url.get('analytics') !== '0' && !automated);
    try {
      owner = localStorage.getItem(OWNER_KEY) === '1'; // index.html tells GA4 too
    } catch {}
    if (!enabled) return;
    let reload = false;
    try {
      reload = !!(session = sessionStorage.getItem(SESSION_KEY) ?? '');
    } catch {}
    if (!reload) {
      session = (crypto.randomUUID?.() ?? `${Math.random()}`.slice(2)).replace(/-/g, '').slice(0, 16);
      try {
        sessionStorage.setItem(SESSION_KEY, session);
      } catch {}
    }
    track('visit', { ...visitFacts(seenBefore()), reload });
    window.addEventListener('error', (e) => trackError('js', e.error ?? e.message));
    window.addEventListener('unhandledrejection', (e) => trackError('js', e.reason));
    // The tab hides (switched away, closed, phone locked): send now, it may not come back.
    document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flush());
    window.addEventListener('pagehide', () => {
      track('leave', { secs: Math.round(performance.now() / 1000), matches });
      flush();
    });
  } catch {
    enabled = false;
  }
}
