import type * as THREE from 'three';

/** `?perf` turns on the frame monitor: an overlay, and `window.__brawl` for scripted measurements (scripts/perf). */
export const PERF = new URLSearchParams(window.location.search).has('perf');

/** Frames kept for the percentiles (~20 s at 60 fps). */
const KEEP = 1200;

type TimerExt = { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number };

/**
 * Per-frame numbers for the render loop: time between frames, CPU time of the loop body (sim ticks, views,
 * camera, issuing the draw), GPU time of the frame (a timer query around the composer, when the browser has
 * EXT_disjoint_timer_query_webgl2), and what renderer.info counted for the whole frame (all passes, shadows too).
 */
export class PerfMonitor {
  private readonly interval = new Float32Array(KEEP);
  private readonly cpu = new Float32Array(KEEP);
  private readonly gpu = new Float32Array(KEEP).fill(NaN);
  private frames = 0;
  private lastNow = 0;
  private started = 0;
  private readonly gl: WebGL2RenderingContext;
  private readonly timer: TimerExt | null;
  /** In-flight GPU queries and the frame each one timed (results come back a few frames later). */
  private readonly pending: { query: WebGLQuery; frame: number }[] = [];
  private readonly free: WebGLQuery[] = [];
  private active: WebGLQuery | null = null;
  /** The last frame's draw stats, and the most seen in one frame. */
  readonly last = { calls: 0, triangles: 0, points: 0, lines: 0 };
  readonly peak = { calls: 0, triangles: 0 };
  private readonly overlay: HTMLDivElement;
  private overlayAt = 0;
  /** Extra lines for the overlay (pose model timing, quality level), set by whoever knows them. */
  extra: () => string = () => '';

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    renderer.info.autoReset = false;
    this.gl = renderer.getContext() as WebGL2RenderingContext;
    this.timer = this.gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExt | null;
    this.overlay = document.createElement('div');
    Object.assign(this.overlay.style, {
      position: 'fixed', left: '8px', top: '8px', zIndex: '100', pointerEvents: 'none', whiteSpace: 'pre',
      font: '11px/1.35 ui-monospace, monospace', color: '#e6ffe6', background: 'rgba(0,0,0,0.6)', padding: '4px 6px',
    });
    document.body.appendChild(this.overlay);
  }

  /** Start of a rAF frame. */
  begin(now: number) {
    if (this.lastNow) this.interval[this.frames % KEEP] = now - this.lastNow;
    else this.interval[this.frames % KEEP] = NaN;
    this.lastNow = now;
    this.started = performance.now();
    this.renderer.info.reset();
    this.collectGpu();
    if (this.timer) {
      this.active = this.free.pop() ?? this.gl.createQuery();
      this.gl.beginQuery(this.timer.TIME_ELAPSED_EXT, this.active);
    }
  }

  /** End of the frame (after the composer has issued everything). */
  end() {
    const i = this.frames % KEEP;
    this.cpu[i] = performance.now() - this.started;
    this.gpu[i] = NaN;
    if (this.timer && this.active) {
      this.gl.endQuery(this.timer.TIME_ELAPSED_EXT);
      this.pending.push({ query: this.active, frame: this.frames });
      this.active = null;
    }
    const r = this.renderer.info.render;
    this.last.calls = r.calls;
    this.last.triangles = r.triangles;
    this.last.points = r.points;
    this.last.lines = r.lines;
    this.peak.calls = Math.max(this.peak.calls, r.calls);
    this.peak.triangles = Math.max(this.peak.triangles, r.triangles);
    this.frames++;
    if (this.started - this.overlayAt > 500) {
      this.overlayAt = this.started;
      this.overlay.textContent = this.text();
    }
  }

  /** Forget everything so far (start of a measurement window). */
  reset() {
    this.frames = 0;
    this.lastNow = 0;
    this.interval.fill(NaN);
    this.cpu.fill(NaN);
    this.gpu.fill(NaN);
    this.peak.calls = this.peak.triangles = 0;
  }

  /** Percentiles over the kept frames (ms), plus the draw stats and GPU memory as three counts it. */
  report() {
    const n = Math.min(this.frames, KEEP);
    const info = this.renderer.info;
    const interval = stats(this.interval, n);
    return {
      frames: n,
      fps: interval.mean ? 1000 / interval.mean : 0,
      interval,
      cpu: stats(this.cpu, n),
      gpu: stats(this.gpu, n),
      /** Frames that took over 1.5x the usual frame time (a visible hitch, whatever the frame cap). */
      hitches: count(this.interval, n, (v) => v > 1.5 * Math.max(interval.p50, 16.7)),
      calls: this.last.calls,
      triangles: this.last.triangles,
      peakCalls: this.peak.calls,
      peakTriangles: this.peak.triangles,
      textures: info.memory.textures,
      geometries: info.memory.geometries,
      programs: info.programs?.length ?? 0,
      pixelRatio: this.renderer.getPixelRatio(),
      drawingBuffer: `${this.gl.drawingBufferWidth}x${this.gl.drawingBufferHeight}`,
      gpuTimer: !!this.timer,
    };
  }

  dispose() {
    this.overlay.remove();
  }

  private collectGpu() {
    if (!this.timer) return;
    const gl = this.gl;
    while (this.pending.length) {
      const { query, frame } = this.pending[0];
      if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) break;
      this.pending.shift();
      const ns = gl.getQueryParameter(query, gl.QUERY_RESULT) as number;
      // A disjoint (clock change, power state) invalidates the in-flight results; keep only clean ones.
      if (!gl.getParameter(this.timer.GPU_DISJOINT_EXT) && frame > this.frames - KEEP && frame < this.frames) {
        this.gpu[frame % KEEP] = ns / 1e6;
      }
      this.free.push(query);
    }
  }

  private text() {
    const r = this.report();
    const f = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : '-');
    return [
      `${r.fps.toFixed(0)} fps  frame p50 ${f(r.interval.p50)} p95 ${f(r.interval.p95)} p99 ${f(r.interval.p99)} max ${f(r.interval.max)}`,
      `cpu ${f(r.cpu.p50)} / p95 ${f(r.cpu.p95)} ms   gpu ${f(r.gpu.p50)} / p95 ${f(r.gpu.p95)} ms`,
      `calls ${r.calls}  tris ${(r.triangles / 1000).toFixed(0)}k  tex ${r.textures}  geo ${r.geometries}  prog ${r.programs}`,
      `px ${r.pixelRatio.toFixed(2)} ${r.drawingBuffer}  ${this.extra()}`,
    ].join('\n');
  }
}

function stats(values: Float32Array, n: number) {
  const list: number[] = [];
  for (let i = 0; i < n; i++) if (Number.isFinite(values[i])) list.push(values[i]);
  list.sort((a, b) => a - b);
  const at = (q: number) => (list.length ? list[Math.min(list.length - 1, Math.floor(q * list.length))] : NaN);
  const mean = list.length ? list.reduce((a, b) => a + b, 0) / list.length : NaN;
  return { n: list.length, mean, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: list.length ? list[list.length - 1] : NaN };
}

function count(values: Float32Array, n: number, test: (v: number) => boolean) {
  let c = 0;
  for (let i = 0; i < n; i++) if (Number.isFinite(values[i]) && test(values[i])) c++;
  return c;
}
