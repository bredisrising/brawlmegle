import { QUALITY_LEVELS, START_LEVEL, quality, type QualityLevel } from './quality';

/** What the pose tracker on this laptop is managing: detections finished per second, camera frames per second, ms each. */
export type PoseRate = { detectFps: number; cameraFps: number; detectMs: number };

const PARAMS = new URLSearchParams(window.location.search);
/** `?qlevel=N` pins a level (0 = full), `?quality=high` pins full quality; otherwise it adapts. */
const PINNED = PARAMS.has('qlevel') ? Math.max(0, Math.min(QUALITY_LEVELS.length - 1, Number(PARAMS.get('qlevel')) || 0)) : PARAMS.get('quality') === 'high' ? 0 : null;

/** Seconds of trouble before a step down, and of ease before trying a step back up (doubles after each failed try). */
const DOWN_AFTER = 2;
/** After a step, the pose rates (2 s windows) still describe the old level: wait this long before judging again. */
const SETTLE_MS = 3000;
const UP_AFTER = 8;
const UP_AFTER_MAX = 64;

/**
 * Keeps the pose tracker fed. The fight looks great at full quality on a strong GPU, but on an integrated one the
 * render takes the whole GPU and MediaPipe (same GPU) drops to a handful of poses a second: the player's moves
 * arrive late and in jumps. Every second this looks at how many poses the tracker finished against the camera's
 * frame rate (and at the render's own frame rate), steps quality down a level while either falls short, and back up
 * after a stretch with room to spare. A step up that fails soon after makes the next try wait twice as long.
 */
export class QualityGovernor {
  level = PINNED ?? START_LEVEL;
  private windowStart = 0;
  private lastTick = 0;
  private drawn = 0;
  /** Longest gap between drawn frames this window: a load (a model parsing) shows up as a few long ones. */
  private maxGap = 0;
  private lastDrawn = 0;
  /** Shortest time between animation frames seen: the display's refresh. */
  private vsync = 1000 / 60;
  private bad = 0;
  private good = 0;
  private upAfter = UP_AFTER;
  private lastUp = -Infinity;
  private settleUntil = 0;
  /** Last window's numbers, for the perf overlay. */
  readonly last = { renderFps: 0, poseFps: 0, cameraFps: 0, detectMs: 0 };

  constructor(
    private readonly apply: (level: QualityLevel) => void,
    private readonly pose: () => PoseRate | null,
    /** Turns the pose tracker's one-pose mode on or off (called every second; a no-op when nothing changes). */
    private readonly onePose: (on: boolean) => void,
  ) {
    quality.level = this.level;
    quality.current = QUALITY_LEVELS[this.level];
  }

  get pinned() {
    return PINNED !== null;
  }

  /**
   * Every animation frame; `drawn` when this one was rendered (the frame cap skips some). `covered`: an opaque screen
   * hides the scene and it's barely drawn, so there's nothing to judge.
   */
  tick(now: number, drawn: boolean, covered = false) {
    const gap = now - this.lastTick;
    this.lastTick = now;
    if (gap > 0 && gap < this.vsync) this.vsync = Math.max(4, gap);
    // A stall (hidden tab, a big load) says nothing about steady-state cost: start the window over.
    if (gap > 250 || !this.windowStart || covered) {
      this.windowStart = now;
      this.drawn = this.maxGap = 0;
      this.lastDrawn = now;
      return;
    }
    if (drawn) {
      this.drawn++;
      this.maxGap = Math.max(this.maxGap, now - this.lastDrawn);
      this.lastDrawn = now;
    }
    if (now - this.windowStart < 1000) return;
    this.evaluate((this.drawn * 1000) / (now - this.windowStart), now);
    this.windowStart = now;
    this.drawn = this.maxGap = 0;
  }

  private evaluate(renderFps: number, now: number) {
    const level = QUALITY_LEVELS[this.level];
    const expected = Math.min(level.maxFps, 1000 / this.vsync);
    const pose = this.pose();
    // Every time, not just on a step: the camera source may have been replaced (a new fighter, a rejoin).
    this.onePose(level.singlePose);
    Object.assign(this.last, { renderFps, poseFps: pose?.detectFps ?? 0, cameraFps: pose?.cameraFps ?? 0, detectMs: pose?.detectMs ?? 0 });
    if (PINNED !== null || now < this.settleUntil) return;

    // A window with a 100+ ms stall is a load or a one-off, not the steady cost of drawing: don't judge it.
    const steady = this.maxGap < 100;
    const renderOk = !steady || renderFps >= expected * 0.85;
    // Camera running: poses should keep up with it (24 a second is plenty for the reader; cameras give 24-60).
    let poseOk = true;
    let poseRoom = true;
    if (pose && pose.cameraFps > 5) {
      const target = Math.min(24, pose.cameraFps * 0.8);
      poseOk = pose.detectFps >= target;
      // Room to try a level up: poses at (nearly) the camera's rate. Detections are pipelined, so how long each takes
      // says little; a step up that starves them again is undone, and the next try waits twice as long.
      poseRoom = pose.detectFps >= Math.min(26, pose.cameraFps * 0.92);
    }

    if (!renderOk || !poseOk) {
      this.good = 0;
      if (++this.bad >= DOWN_AFTER && this.level < QUALITY_LEVELS.length - 1) {
        // Undone soon after going up: that level doesn't fit, wait longer before trying it again.
        if (now - this.lastUp < 15_000) this.upAfter = Math.min(UP_AFTER_MAX, this.upAfter * 2);
        this.step(this.level + 1, `poses ${pose ? pose.detectFps.toFixed(0) : '-'}/s of ${pose ? pose.cameraFps.toFixed(0) : '-'}, render ${renderFps.toFixed(0)}/${expected.toFixed(0)} fps`);
      }
      return;
    }
    this.bad = 0;
    // Back up only with room for it: drawing at the cap (with a little extra GPU time) and poses comfortably fast.
    if (steady && poseRoom && renderFps >= expected * 0.95) {
      if (++this.good >= this.upAfter && this.level > 0) {
        this.lastUp = now;
        this.step(this.level - 1, 'room to spare');
      }
    } else {
      this.good = 0;
    }
  }

  private step(level: number, why: string) {
    this.level = level;
    this.settleUntil = performance.now() + SETTLE_MS;
    this.bad = this.good = 0;
    quality.level = level;
    quality.current = QUALITY_LEVELS[level];
    console.info(`[quality] ${QUALITY_LEVELS[level].name} (level ${level}): ${why}`);
    this.apply(QUALITY_LEVELS[level]);
  }
}

/** One-pose mode for an input source, if it's a camera that has it (CameraSource.setSinglePose). */
export function setOnePose(source: unknown, on: boolean) {
  (source as { setSinglePose?: (on: boolean) => void } | null)?.setSinglePose?.(on);
}

/** The pose tracker's numbers from an input source, if it's a camera that reports them (CameraSource.stats). */
export function poseRateOf(source: unknown): PoseRate | null {
  const stats = (source as { kind?: string; stats?: Partial<PoseRate> } | null)?.stats;
  if ((source as { kind?: string } | null)?.kind !== 'camera' || !stats || typeof stats.detectFps !== 'number') return null;
  // Nothing to judge until the model has run for a full rate window (it takes a few seconds to load).
  if (!(stats as { rated?: boolean }).rated) return null;
  return { detectFps: stats.detectFps, cameraFps: stats.cameraFps ?? 0, detectMs: stats.detectMs ?? 0 };
}
