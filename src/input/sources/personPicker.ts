/** A landmark as MediaPipe gives it (its NormalizedLandmark) or as the game keeps it (Landmark). */
type Point = { x: number; y: number; visibility?: number };
type Pose = readonly Point[];

/** Acquiring: how much a person's size counts against their distance from the middle (both in frame heights). */
const SIZE_WEIGHT = 2;
/**
 * Following: how far (in the player's body sizes) a pose may be from where they were: a step, a little more after a
 * gap, never as far sideways as a friend sitting shoulder to shoulder (~1.2), since that's when swaps happened: the
 * player's own detection failed (a blurred cross, fists over the face) and the friend was the only one found. Up and
 * down counts half: a duck or getting up moves the shoulders a torso's length in a frame or two at 10 poses/s, and
 * someone above or below the player (standing behind them) is a different size.
 */
const STEP = 0.8;
const SPEED = 1.5;
const REACH = 1.1;
const VERTICAL = 0.5;
/** Following: how much smaller or bigger than the player a pose may be (leaning in, turning, framing jitter). */
const SIZE_MIN = 0.55;
const SIZE_MAX = 1.8;
/**
 * This long without the player and they're forgotten: the biggest person near the middle is taken again. Sooner for
 * someone seen only a few times: on real recordings, the first pose was sometimes a sliver at the frame's edge.
 */
const FORGET_MS = 3000;
const FORGET_NEW_MS = 500;
const ESTABLISHED = 10;
/** Someone this much bigger (nearer the camera) than who's followed, for this long, is the player. */
const BIGGER = 1.5;
const BIGGER_MS = 1500;
/** Hips under this visibility are MediaPipe's guess (seated, hips below the picture): not used. */
const SEEN = 0.5;

/**
 * Which of the people MediaPipe found is the player, frame after frame (the camera source and its worker share it).
 *
 * To start, the biggest person near the middle of the frame: by size, not by height in the frame, since a seated
 * player's hips are below the picture (MediaPipe guesses them) while someone standing behind has theirs right in the
 * middle. After that, a pose is the player's only if it's near where they just were and about their size. Someone
 * else in frame (a bystander walking past, the friend beside you) is never taken instead: while the player isn't
 * found, nobody is (the reader holds their last pose, then reads them as gone), until they've been gone for a few
 * seconds. Someone much bigger than who's followed, for a second and a half, takes over: the player sat down in
 * front of whoever the camera saw first.
 *
 * On the hackathon recordings (40k frames) it drops 58% of the whole-skeleton jumps (about half of each flip-flop is
 * the jump back to the player) and 1–2% of all frames.
 */
export class PersonPicker {
  /** The player: shoulder center (frame heights from the top left), body size, when last found, and how many times. */
  private anchor: { x: number; y: number; size: number; t: number; hits: number } | null = null;
  /** Since when someone much bigger than the player has been in frame. */
  private biggerSince = NaN;

  /** When the player was last found (-Infinity before that). */
  get seenAt() {
    return this.anchor?.t ?? -Infinity;
  }

  reset() {
    this.anchor = null;
    this.biggerSince = NaN;
  }

  /** The player's pose among `poses` (its index), or -1: nobody, or only other people. `aspect`: frame width / height. */
  pick(poses: readonly Pose[], t: number, aspect = 1): number {
    const found = poses.map((p) => measure(p, aspect));
    if (this.anchor && t - this.anchor.t >= (this.anchor.hits < ESTABLISHED ? FORGET_NEW_MS : FORGET_MS)) this.reset();
    const a = this.anchor;
    let best = -1;
    let lowest = Infinity;
    found.forEach((m, i) => {
      if (!m) return;
      let cost: number;
      if (a) {
        const ratio = m.size / a.size;
        const distance = Math.hypot(m.x - a.x, (m.y - a.y) * VERTICAL) / a.size;
        if (ratio < SIZE_MIN || ratio > SIZE_MAX || distance > Math.min(REACH, STEP + (SPEED * Math.max(0, t - a.t)) / 1000)) return;
        cost = distance + Math.abs(Math.log(ratio));
      } else {
        cost = Math.abs(m.x - aspect / 2) - SIZE_WEIGHT * m.size;
      }
      if (cost < lowest) {
        lowest = cost;
        best = i;
      }
    });
    if (a) {
      const followed = best >= 0 ? found[best]!.size : a.size;
      const big = found.findIndex((m, i) => i !== best && !!m && m.size > followed * BIGGER);
      if (big < 0) this.biggerSince = NaN;
      else if (Number.isNaN(this.biggerSince)) this.biggerSince = t;
      else if (t - this.biggerSince >= BIGGER_MS) {
        best = big;
        this.reset(); // a new player: their size, not an average with the old one's
      }
    }
    if (best >= 0) this.follow(found[best]!, t);
    return best;
  }

  private follow(m: { x: number; y: number; size: number }, t: number) {
    const a = this.anchor;
    this.anchor = { x: m.x, y: m.y, size: a ? a.size + (m.size - a.size) * 0.2 : m.size, t, hits: (a?.hits ?? 0) + 1 };
  }
}

/**
 * Where a pose is (its shoulder center) and how big (shoulder width, or 0.7 of the torso when the hips are really
 * seen: a player turned side-on to throw a hook has narrow shoulders), in frame heights. Null without shoulders.
 */
function measure(p: Pose, aspect: number): { x: number; y: number; size: number } | null {
  const [ls, rs, lh, rh] = [p[11], p[12], p[23], p[24]];
  if (!ls || !rs) return null;
  const x = ((ls.x + rs.x) / 2) * aspect;
  const y = (ls.y + rs.y) / 2;
  let size = Math.hypot((ls.x - rs.x) * aspect, ls.y - rs.y);
  if (lh && rh && (lh.visibility ?? 1) >= SEEN && (rh.visibility ?? 1) >= SEEN) {
    size = Math.max(size, 0.7 * Math.hypot(((lh.x + rh.x) / 2) * aspect - x, (lh.y + rh.y) / 2 - y));
  }
  return Number.isFinite(x + y + size) && size > 0 ? { x, y, size } : null;
}
