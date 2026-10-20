import { useEffect, useRef, useState } from 'react';
import { config } from '../config';
import type { ForgePreview as Preview } from '../types';
import { createForgePreview, type ForgePreviewView } from './forgePreview3d';

/** The forge's stages, as the card counts them off. */
const STAGES = [
  ['Brief', 'Sizing you up'],
  ['Sheet', 'Drawing your fighter'],
  ['Voxels', 'Blocking out the shape'],
  ['Clay', 'Sculpting'],
  ['Paint', 'Painting and rigging'],
  ['Rig', 'Rigged'],
  ['Live', 'Materializing'],
] as const;

/** Which stage the preview is at, from what exists so far. */
function stageOf(p: Preview | null, revealed: boolean): number {
  if (p?.glbUrl) return revealed ? 5 : 4; // the paint sweeps in, then the rig flashes (live: the arena's materialize)
  if (p?.step === 'rig') return 4; // the box is painting (baking) and rigging
  if (p?.meshUrl) return 3;
  if (p?.voxelsUrl) return 2;
  if (p?.sheetUrl) return 1;
  return 0;
}

/** Types `text` out, a few characters per frame. */
function useTyped(text: string | undefined, cps = 30): string {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    setShown(0);
    if (!text) return;
    const start = performance.now();
    const id = window.setInterval(() => {
      const n = Math.min(text.length, Math.floor(((performance.now() - start) / 1000) * cps));
      setShown(n);
      if (n >= text.length) window.clearInterval(id);
    }, 40);
    return () => window.clearInterval(id);
  }, [text, cps]);
  return text ? text.slice(0, shown) : '';
}

/**
 * The forging card's live preview, so a forge is something to watch: the brief typing out, the sheet developing,
 * then (from the GPU box) a voxel hologram building up, the clay sculpt and the finished fighter with its rig
 * flashing, before it materializes in the arena. Without the GPU box's intermediates it holds the sheet.
 */
/**
 * The preview's height: about half the screen's height, and no wider than its half of the screen allows (3:4). The
 * forging panel drops its other text while the preview shows, so this fits a 1366x657 laptop window.
 */
const PREVIEW_SIZE = 'h-[min(50vh,52vw)] sm:h-[min(54vh,40vw)]';
const PREVIEW_BAR = 'max-w-[calc(min(50vh,52vw)*0.75+8px)] sm:max-w-[calc(min(54vh,40vw)*0.75+8px)]';

export function ForgePreview({
  preview,
  art,
  color,
  hex,
  other,
  right,
}: {
  preview: Preview | null;
  /** The design art (card, else sheet) when there's no preview yet. */
  art: string | null;
  color: string;
  hex: string;
  other: string;
  right: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef<ForgePreviewView | null>(null);
  const [revealed, setRevealed] = useState(false);
  const sheet = preview?.sheetUrl ?? art ?? undefined;
  const three = Boolean(preview?.voxelsUrl || preview?.meshUrl || preview?.glbUrl);
  const stage = stageOf(preview, revealed);
  const name = useTyped(preview?.name);
  const archetype = useTyped(preview?.archetype ? `${preview.archetype}` : undefined, 40);
  // While the sheet draws (~20 s): a scouting dossier from the brief, typed out.
  const dossier = useTyped(preview?.dossier?.join('\n'), 45);

  // One preview view per card while it has 3D stages; each stage is handed over as its URL appears.
  useEffect(() => {
    if (!three || !canvasRef.current) return;
    const view = createForgePreview(canvasRef.current, hex, other, config.lowPower);
    viewRef.current = view;
    return () => {
      view.dispose();
      viewRef.current = null;
    };
  }, [three, hex, other]);
  useEffect(() => {
    if (preview?.voxelsUrl) void viewRef.current?.showVoxels(preview.voxelsUrl).catch(() => {});
  }, [three, preview?.voxelsUrl]);
  useEffect(() => {
    if (preview?.meshUrl) void viewRef.current?.showClay(preview.meshUrl).catch(() => {});
  }, [three, preview?.meshUrl]);
  useEffect(() => {
    if (!preview?.glbUrl) return;
    void viewRef.current?.showFinal(preview.glbUrl).catch(() => {});
    // The paint sweeps in (0.7 s), then the rig flashes.
    const id = window.setTimeout(() => setRevealed(true), 700);
    return () => window.clearTimeout(id);
  }, [three, preview?.glbUrl]);

  const [label, line] = STAGES[stage];
  return (
    <div className={`animate-slam flex flex-col gap-2 ${right ? 'items-end origin-right' : 'items-start origin-left'}`}>
      <div className={`cut ${color} p-[4px] [--cut:14px]`}>
        {/* The show-off piece of the forging screen: as big as the player's half allows (see PREVIEW_SIZE). */}
        <div className={`cut relative aspect-[3/4] ${PREVIEW_SIZE} overflow-hidden bg-ink [--cut:12px]`}>
          {/* Stage 2: the sheet developing (blurred and scanned while it's a partial), then a corner thumbnail. */}
          {sheet && (
            <img
              src={sheet}
              alt="Your fighter's design"
              className={`absolute object-contain transition-all duration-700 ${
                three ? 'right-2 top-9 h-[28%] w-auto opacity-80 [filter:grayscale(0.3)]' : 'inset-0 h-full w-full'
              } ${!three && !preview?.sheetFinal && preview?.sheetUrl ? '[filter:blur(3px)_saturate(0.55)_contrast(1.15)]' : ''}`}
            />
          )}
          {sheet && !three && !preview?.sheetFinal && <span className="forge-develop absolute inset-0" />}
          {/* Stages 3-6: the 3D preview. */}
          {three && <canvas ref={canvasRef} className="absolute inset-0 h-full w-full [image-rendering:pixelated]" />}
          {/* Stage 1: the brief, typed out as a dossier while the sheet draws, then kept as a caption. */}
          {(name || archetype) && (
            <div className={`absolute inset-x-3 flex flex-col gap-1 ${sheet || three ? 'bottom-3' : 'top-9'}`}>
              <span className="font-display text-2xl uppercase leading-none tracking-tight text-paper drop-shadow-[0_2px_0_rgba(0,0,0,0.8)] sm:text-3xl">
                {name}
              </span>
              <span className="font-cond text-xs font-bold uppercase tracking-[0.25em] text-paper/80">{archetype}</span>
              {!sheet && !three && preview?.palette && (
                <span className="mt-2 flex gap-1">
                  {preview.palette.map((c) => (
                    <span key={c} className="h-4 w-7 border border-paper/30" style={{ background: c }} />
                  ))}
                </span>
              )}
              {!sheet && !three && dossier && (
                <p className="mt-2 whitespace-pre-line font-cond text-[13px] font-semibold uppercase leading-snug tracking-[0.08em] text-paper/75">
                  {dossier}
                  <span className="animate-blink">_</span>
                </p>
              )}
            </div>
          )}
          {!sheet && !three && !name && <span className="forge-develop absolute inset-0 opacity-60" />}
          <span className="forge-scanlines pointer-events-none absolute inset-0" />
          <span className="absolute left-2 top-2 bg-ink/80 px-2 py-0.5 font-cond text-[11px] font-bold uppercase tracking-[0.25em] text-paper">
            0{stage + 1} · {label}
          </span>
        </div>
      </div>
      <div className={`flex w-full ${PREVIEW_BAR} gap-1`}>
        {STAGES.map(([s], i) => (
          <span key={s} className={`h-1.5 flex-1 ${i < stage ? 'bg-paper' : i === stage ? `${color} animate-blink` : 'bg-ink-3'}`} />
        ))}
      </div>
      <span className="font-cond text-sm font-bold uppercase tracking-[0.25em] text-paper/70">{line}…</span>
    </div>
  );
}
