export type InputKind = 'mock' | 'camera';

const params = new URLSearchParams(window.location.search);
/** A phone (touch-first, small screen): it runs MediaPipe and the 3D on one small GPU, so it gets a lighter game. */
const phone = typeof matchMedia === 'function' && matchMedia('(pointer: coarse) and (max-width: 900px)').matches;
/** `?quality=low|high` overrides; phones default to low. */
const lowPower = params.get('quality') ? params.get('quality') === 'low' : phone;
const env = import.meta.env;
const turnUrl = env.VITE_TURN_URL as string | undefined;

/**
 * The public server: the game, the forge (/api/) and the matchmaker (/ws) share one domain. A page served from one of
 * those names talks to that same name (no cross-origin calls); anywhere else (local dev) uses the main one.
 */
const PUBLIC_HOSTS = ['brawlmegle.com', 'www.brawlmegle.com', 'brawlmegle.vip', 'www.brawlmegle.vip'];
const SERVER = PUBLIC_HOSTS.includes(window.location.hostname) ? window.location.host : 'brawlmegle.com';

export const config = {
  /** Source for the player tracked on this machine: the camera on the real site, a mock in local dev. `?input=` overrides. */
  input: (params.get('input') ?? import.meta.env.VITE_INPUT ?? (import.meta.env.DEV ? 'mock' : 'camera')) as InputKind,
  /** AWS signaling server (WebSocket) that brokers the P2P handshake. */
  signalUrl: (import.meta.env.VITE_SIGNAL_URL as string | undefined) ?? `wss://${SERVER}/ws`,
  /**
   * "Find a fight" queue: '' is the live game's; a build served from a subfolder (the /next/ test build) gets its own,
   * so someone trying new rules is never matched with a player on the live game.
   */
  matchPool: import.meta.env.BASE_URL.replace(/\//g, ''),
  /** STUN + optional TURN (coturn on the signaling box) for venue Wi-Fi that blocks direct P2P. */
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    ...(turnUrl ? [{ urls: turnUrl, username: env.VITE_TURN_USER as string, credential: env.VITE_TURN_PASS as string }] : []),
  ] as RTCIceServer[],
  /** Forge server: shared, so a username's fighter is the same on every laptop. VITE_FORGE_API= (empty) mocks it. */
  forgeApi: (import.meta.env.VITE_FORGE_API as string | undefined) ?? `https://${SERVER}`,
  /**
   * Sent with forge requests so random people can't spend our image/3D credits through the public endpoint.
   * Not a real secret (it ships in the page); the server also caps forges per hour and per day.
   */
  forgeKey: (import.meta.env.VITE_FORGE_KEY as string | undefined) ?? '720f66ea6f3cebda14050f8fa706cc1a',
  /**
   * How much of the player's real body shows on their fighter (0..1). Moves always come from the fight engine; this
   * only adds their lean, head and hand positions on top of the fighting stance. `?live=` overrides.
   */
  liveBlend: clamp01(Number(params.get('live') ?? 0.25)),
  /**
   * Fighters animate "on twos" like hand-animated fighting games: poses hold and step at this rate (0 = smooth).
   * Key frames (a strike landing, a hit) always show on the frame they happen. `?fps=` overrides.
   */
  animFps: Math.max(0, Number(params.get('fps') ?? 12) || 0),
  /** Phones (or `?quality=low`): lower resolution, no bloom, shadows or outlines. */
  lowPower,
  /** Ink outline around the fighters (`?outline=0` turns it off; off in low power). */
  outline: params.get('outline') ? params.get('outline') !== '0' : !lowPower,
  /** Full-screen impact frames on big hits (`?fx=low` turns them off, e.g. for flashing-light sensitivity). */
  impactFrames: params.get('fx') !== 'low',
  /**
   * Booth demo (`?demo=1`, on the host): rounds that end fast for a fight running behind a pitch. Hits do 1.6x
   * damage, the clock is 45 s, and the entrance plays only before the first round.
   */
  demo: params.get('demo') === '1',
  /**
   * `?models=full`: forged fighters load their uncompressed originals (the GLB as the 3D step made it, ~2-11 MB more
   * each) instead of the optimized copy, to compare quality. Falls back to the optimized one when there's no original.
   */
  fullModels: params.get('models') === 'full',
  /** The learned move model reads alongside the rules (DEFAULT_INTENT.model); `?model=0` turns it off to compare. */
  moveModel: params.get('model') !== '0',
  /**
   * Online, the client's moves reach the host's engine half a round trip late. The host holds its own player's commands
   * back by the same (up to this many ms) so neither side wins trades by being the host. `?fair=0` turns it off.
   */
  fairDelayMaxMs: params.get('fair') === '0' ? 0 : 60,
  /** `?forge=hq`: the slower, sharper forge (bigger sheet, more sculpting steps, bigger textures), for showcase fighters. */
  forgeQuality: params.get('forge') === 'hq' ? ('hq' as const) : undefined,
};

function clamp01(v: number) {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.25;
}
