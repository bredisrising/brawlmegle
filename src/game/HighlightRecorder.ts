import { config } from '../config';
import { uploadHighlight, type HighlightMeta } from '../forge/highlights';

/** The clip: 960x540 at 30 fps, VP9 (VP8 where VP9 can't record), video only. */
const WIDTH = 960;
const HEIGHT = 540;
const FPS = 30;
const BITRATE = 1_200_000;
/** A replay runs ~7 s; never record longer than this whatever happens. */
const MAX_SECONDS = 9;
/** Shorter than this (a replay cut off by a quick rematch) isn't a highlight. */
const MIN_SECONDS = 2.5;
/** The server's cap is 6 MB; a clip this size means something went wrong. */
const MAX_BYTES = 6 * 1024 * 1024;
const TYPES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];

/**
 * Records the K.O. replay off the game's WebGL canvas (only the 3D scene: the camera picture and every overlay are
 * DOM, never drawn into it) and uploads it as a highlight for the title screen's reel.
 *
 * The WebGL canvas is screen-sized (up to 4K on a big display), so it isn't captured directly: after each drawn frame
 * (Renderer.onDrawn) it's scaled into a small 960x540 canvas, center-cropped to 16:9, at most 30 times a second, and
 * that small canvas is what MediaRecorder encodes. One GPU blit per frame, and the encoder only ever sees 540p.
 */
export class HighlightRecorder {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private track: CanvasCaptureMediaStreamTrack | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private source: HTMLCanvasElement | null = null;
  private meta: Omit<HighlightMeta, 'duration'> | null = null;
  private started = 0;
  private lastFrame = -Infinity;
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** Recording works here: not a phone (lowPower), and the browser has canvas capture and a WebM recorder. */
  static supported() {
    return !config.lowPower && !!config.forgeApi && typeof MediaRecorder !== 'undefined' &&
      typeof HTMLCanvasElement.prototype.captureStream === 'function' && !!pickType();
  }

  get recording() {
    return !!this.recorder;
  }

  /** Start recording `source` (the game's canvas). Call frame() after every frame drawn into it. */
  start(source: HTMLCanvasElement, meta: Omit<HighlightMeta, 'duration'>) {
    this.cancel();
    const type = pickType();
    if (!type) return;
    try {
      if (!this.canvas) {
        this.canvas = document.createElement('canvas');
        this.canvas.width = WIDTH;
        this.canvas.height = HEIGHT;
        this.ctx = this.canvas.getContext('2d', { alpha: false });
      }
      // Frames go out only when frame() pushes one (requestFrame), never on a timer of the browser's.
      const stream = this.canvas.captureStream(0);
      this.track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
      const recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: BITRATE });
      // Its own list: the last chunk arrives after stop(), when this recorder may already be replaced.
      const chunks: Blob[] = [];
      this.chunks = chunks;
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      recorder.start(1000);
      this.recorder = recorder;
      this.source = source;
      this.meta = meta;
      this.started = performance.now();
      this.lastFrame = -Infinity;
      this.timer = setTimeout(() => this.finish(), MAX_SECONDS * 1000);
      this.frame();
    } catch (err) {
      console.warn('highlight recording unavailable:', err);
      this.cancel();
    }
  }

  /** The game drew a frame: copy it into the clip (at most FPS times a second). Must run right after the draw. */
  frame() {
    if (!this.recorder || !this.source || !this.ctx || !this.track) return;
    const now = performance.now();
    if (now - this.lastFrame < 1000 / FPS - 4) return;
    this.lastFrame = now;
    // Cover-crop the screen to 16:9 (a wide or tall window keeps its middle).
    const { width: sw, height: sh } = this.source;
    if (!sw || !sh) return;
    const scale = Math.max(WIDTH / sw, HEIGHT / sh);
    const w = WIDTH / scale;
    const h = HEIGHT / scale;
    this.ctx.drawImage(this.source, (sw - w) / 2, (sh - h) / 2, w, h, 0, 0, WIDTH, HEIGHT);
    this.track.requestFrame();
  }

  /** The replay ended: stop and upload (in the background). */
  finish() {
    const recorder = this.recorder;
    const meta = this.meta;
    if (!recorder || !meta) return;
    const duration = (performance.now() - this.started) / 1000;
    const chunks = this.chunks;
    recorder.onstop = () => {
      const video = new Blob(chunks, { type: recorder.mimeType });
      if (duration < MIN_SECONDS || video.size < 10_000 || video.size > MAX_BYTES) return;
      void uploadHighlight(video, { ...meta, duration: Math.round(duration * 10) / 10 });
    };
    this.release(recorder);
  }

  /** Drop the recording (a rematch cut the replay short). */
  cancel() {
    if (this.recorder) this.recorder.onstop = null;
    this.release(this.recorder);
  }

  private release(recorder: MediaRecorder | null) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      if (recorder && recorder.state !== 'inactive') recorder.stop();
    } catch {}
    this.track?.stop();
    this.track = null;
    this.recorder = null;
    this.source = null;
    this.meta = null;
  }
}

function pickType() {
  if (typeof MediaRecorder === 'undefined') return null;
  return TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? null;
}
