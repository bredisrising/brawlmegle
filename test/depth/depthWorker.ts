// Depth Anything V2 Small in a Worker: frame bitmap + landmark positions in, depth samples out.
// Runs off the UI thread so MediaPipe and drawing never wait on it.
import { AutoModel, Tensor, env, type PreTrainedModel } from '@huggingface/transformers';

const MODEL_ID = 'onnx-community/depth-anything-v2-small';
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

export type DeviceChoice = 'auto' | 'webgpu' | 'wasm';
export type InitMsg = { type: 'init'; device: DeviceChoice };
export type FrameMsg = {
  type: 'frame';
  t: number;
  bitmap: ImageBitmap;
  /** Normalized image coords (0..1) of the points to sample. */
  points: Record<string, [number, number]>;
  /** Patch half-size as a fraction of the image width. */
  patch: number;
  wantMap: boolean;
};
export type ReadyMsg = { type: 'ready'; device: 'webgpu' | 'wasm'; dtype: string; loadMs: number };
export type DepthMsg = {
  type: 'depth';
  t: number;
  /** Model run only. */
  ms: number;
  /** Preprocess + model + sampling. */
  totalMs: number;
  w: number;
  h: number;
  /** Patch medians of the relative inverse depth (bigger = closer), per point. */
  samples: Record<string, number>;
  /** Percentiles of the whole frame, for scale-free normalization. */
  pct: { p5: number; p10: number; p50: number; p90: number; p95: number };
  /** 8-bit depth map (p2..p98 stretched) for the overlay. */
  map?: Uint8Array;
};
export type ErrorMsg = { type: 'error'; message: string };

let model: PreTrainedModel | null = null;
let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;

env.allowLocalModels = false;

self.onmessage = async (event: MessageEvent<InitMsg | FrameMsg>) => {
  const msg = event.data;
  try {
    if (msg.type === 'init') await init(msg.device);
    else if (msg.type === 'frame') await runFrame(msg);
  } catch (err) {
    post({ type: 'error', message: (err as Error).message ?? String(err) });
  }
};

function post(msg: ReadyMsg | DepthMsg | ErrorMsg, transfer: Transferable[] = []) {
  (self as unknown as Worker).postMessage(msg, transfer);
}

async function init(choice: DeviceChoice) {
  const started = performance.now();
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  const hasGpu = !!gpu && !!(await gpu.requestAdapter().catch(() => null));
  const tryGpu = choice === 'webgpu' || (choice === 'auto' && hasGpu);
  if (tryGpu) {
    try {
      model = await AutoModel.from_pretrained(MODEL_ID, { device: 'webgpu', dtype: 'fp16' });
      post({ type: 'ready', device: 'webgpu', dtype: 'fp16', loadMs: performance.now() - started });
      return;
    } catch (err) {
      console.warn('WebGPU depth failed, falling back to WASM', err);
    }
  }
  // WASM: the 8-bit model is ~4x smaller and runs faster on CPU.
  model = await AutoModel.from_pretrained(MODEL_ID, { device: 'wasm', dtype: 'q8' });
  post({ type: 'ready', device: 'wasm', dtype: 'q8', loadMs: performance.now() - started });
}

async function runFrame(msg: FrameMsg) {
  if (!model) throw new Error('model not loaded');
  const started = performance.now();
  const { bitmap } = msg;
  const w = bitmap.width;
  const h = bitmap.height;
  if (!canvas || canvas.width !== w || canvas.height !== h) {
    canvas = new OffscreenCanvas(w, h);
    ctx = canvas.getContext('2d', { willReadFrequently: true });
  }
  ctx!.drawImage(bitmap, 0, 0);
  bitmap.close();
  const rgba = ctx!.getImageData(0, 0, w, h).data;
  const n = w * h;
  const data = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    data[i] = (rgba[4 * i] / 255 - MEAN[0]) / STD[0];
    data[n + i] = (rgba[4 * i + 1] / 255 - MEAN[1]) / STD[1];
    data[2 * n + i] = (rgba[4 * i + 2] / 255 - MEAN[2]) / STD[2];
  }
  const pixelValues = new Tensor('float32', data, [1, 3, h, w]);

  const runStart = performance.now();
  const out = (await model({ pixel_values: pixelValues })) as { predicted_depth: Tensor };
  const ms = performance.now() - runStart;
  let depthT = out.predicted_depth;
  if (depthT.type !== 'float32') depthT = depthT.to('float32');
  const depth = depthT.data as Float32Array;
  const [dh, dw] = depthT.dims.slice(-2);

  const samples: Record<string, number> = {};
  const r = Math.max(1, Math.round(msg.patch * dw));
  for (const [name, [x, y]] of Object.entries(msg.points)) samples[name] = patchMedian(depth, dw, dh, x * dw, y * dh, r);

  // Percentiles from a strided subsample (~4k values) are plenty.
  const stride = Math.max(1, Math.floor(depth.length / 4096));
  const sub: number[] = [];
  for (let i = 0; i < depth.length; i += stride) sub.push(depth[i]);
  sub.sort((a, b) => a - b);
  const q = (p: number) => sub[Math.min(sub.length - 1, Math.floor(p * sub.length))];
  const pct = { p5: q(0.05), p10: q(0.1), p50: q(0.5), p90: q(0.9), p95: q(0.95) };

  let map: Uint8Array | undefined;
  if (msg.wantMap) {
    const lo = q(0.02);
    const span = Math.max(1e-6, q(0.98) - lo);
    map = new Uint8Array(dw * dh);
    for (let i = 0; i < map.length; i++) map[i] = Math.max(0, Math.min(255, ((depth[i] - lo) / span) * 255));
  }
  post({ type: 'depth', t: msg.t, ms, totalMs: performance.now() - started, w: dw, h: dh, samples, pct, map }, map ? [map.buffer] : []);
}

/** Median of a square patch around (cx, cy), clipped to the map. NaN if the point is off the map. */
function patchMedian(depth: Float32Array, w: number, h: number, cx: number, cy: number, r: number) {
  const x0 = Math.max(0, Math.round(cx - r));
  const x1 = Math.min(w - 1, Math.round(cx + r));
  const y0 = Math.max(0, Math.round(cy - r));
  const y1 = Math.min(h - 1, Math.round(cy + r));
  if (x0 > x1 || y0 > y1) return NaN;
  const vals: number[] = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) vals.push(depth[y * w + x]);
  vals.sort((a, b) => a - b);
  return vals[vals.length >> 1];
}
