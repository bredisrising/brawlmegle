import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { config } from '../config';
import type { ForgePreview as Preview } from '../types';
import { createForgePreview, PAINT_SWEEP, RIG_FLASH, type ForgePreviewView } from './forgePreview3d';

/** The forge's stages, as the card counts them off. */
const STAGES = [
  ['Brief', 'Sizing you up'],
  ['Sheet', 'Drawing your fighter'],
  ['Voxels', 'Blocking out the shape'],
  ['Clay', 'Sculpting'],
  ['Paint', 'Painting and rigging'],
  ['Rig', 'Rigged'],
  ['Forged', 'Into the arena'],
] as const;

/** How far the finished fighter has landed: not yet, painted (the rig flashing), forged (the finish). */
type Landed = 0 | 1 | 2;

/** Which stage the preview is at, from what exists so far. */
function stageOf(p: Preview | null, landed: Landed): number {
  if (p?.glbUrl) return 4 + landed; // the paint sweeps in, the rig flashes, then it's forged
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

const STAGE_MEDIA = '(min-width: 1024px) and (min-height: 560px)';

/**
 * Room for the big forge stage (ForgePreview `stage`, half the screen) instead of the card in the player's panel:
 * laptop-sized windows and up. Phones and small windows keep the card.
 */
export function useStageFits(): boolean {
  const [fits, setFits] = useState(() => typeof matchMedia === 'function' && matchMedia(STAGE_MEDIA).matches);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const query = matchMedia(STAGE_MEDIA);
    const update = () => setFits(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return fits;
}

/**
 * The card's height: about half the screen's height, and no wider than its half of the screen allows (3:4). The
 * forging panel drops its other text while the card shows, so this fits a 1366x657 laptop window.
 */
const PREVIEW_SIZE = 'h-[min(50vh,52vw)] sm:h-[min(54vh,40vw)]';
const PREVIEW_BAR = 'max-w-[calc(min(50vh,52vw)*0.75+8px)] sm:max-w-[calc(min(54vh,40vw)*0.75+8px)]';
/** The stage: the biggest 3:4 that fits the box it's given (a size container). */
const STAGE_FIT: CSSProperties = { width: 'min(100cqw, 75cqh)', height: 'min(100cqh, 133.33cqw)' };

/**
 * Something to watch while it forges: the brief typing out, the sheet developing, then (from the GPU box) a voxel
 * hologram building up, the clay sculpt and the finished fighter painting in with its rig flashing, then the finish
 * (Game.ts holds on it for a few seconds before the fight). Without the GPU box's intermediates it holds the sheet.
 *
 * Two sizes: the card in the player's panel (phones, the other player's forge, both forging at once), and `stage`:
 * the forging player's big moment, filling the box it's placed in (the lobby's right half, the client laptop's).
 */
export function ForgePreview({
  preview,
  art,
  color,
  hex,
  other,
  right,
  stage = false,
}: {
  preview: Preview | null;
  /** The design art (card, else sheet) when there's no preview yet. */
  art: string | null;
  color: string;
  hex: string;
  other: string;
  right: boolean;
  stage?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef<ForgePreviewView | null>(null);
  const [landed, setLanded] = useState<Landed>(0);
  const sheet = preview?.sheetUrl ?? art ?? undefined;
  const three = Boolean(preview?.voxelsUrl || preview?.meshUrl || preview?.glbUrl);
  const index = stageOf(preview, landed);
  const forged = landed === 2;
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
    setLanded(0);
    if (!preview?.glbUrl) return;
    // Timed from when the model is actually in (it downloads first): the paint sweeps in, the rig flashes, forged.
    const timers: number[] = [];
    let alive = true;
    const land = () => {
      if (!alive) return;
      timers.push(window.setTimeout(() => setLanded(1), PAINT_SWEEP * 1000));
      timers.push(window.setTimeout(() => setLanded(2), (PAINT_SWEEP + RIG_FLASH) * 1000));
    };
    const view = viewRef.current;
    if (view) void view.showFinal(preview.glbUrl).then(land, land);
    else land();
    return () => {
      alive = false;
      timers.forEach((id) => window.clearTimeout(id));
    };
  }, [three, preview?.glbUrl]);

  const [label, line] = STAGES[index];
  // Canvas 2D (lowPower) has no finished model: the fighter's card art stands in once it's forged.
  const cardArt = forged && config.lowPower && art;
  const segments = (
    <div className={`flex w-full gap-1 ${stage ? '' : PREVIEW_BAR}`}>
      {STAGES.map(([s], i) => (
        <span
          key={s}
          className={`h-1.5 flex-1 ${forged ? 'bg-hp' : i < index ? 'bg-paper' : i === index ? `${color} animate-blink` : 'bg-ink-3'}`}
        />
      ))}
    </div>
  );

  const screen = (
    <>
      {/* The stage's floor: a glow in the player's color where the fighter turns. */}
      {stage && (
        <span
          aria-hidden
          className="absolute inset-0 transition-opacity duration-500"
          style={{ background: `radial-gradient(ellipse 58% 13% at 50% 92%, ${forged ? '#ffd400' : hex}66, transparent 70%)` }}
        />
      )}
      {/* Stage 2: the sheet developing (blurred and scanned while it's a partial), then a corner thumbnail. */}
      {sheet && (
        <img
          src={sheet}
          alt="Your fighter's design"
          className={`absolute object-contain transition-all duration-700 ${
            three ? `right-2 h-[24%] w-auto opacity-80 [filter:grayscale(0.3)] ${stage ? 'top-16' : 'top-9'} ${forged ? '!opacity-0' : ''}` : 'inset-0 h-full w-full'
          } ${!three && !preview?.sheetFinal && preview?.sheetUrl ? '[filter:blur(3px)_saturate(0.55)_contrast(1.15)]' : ''}`}
        />
      )}
      {sheet && !three && !preview?.sheetFinal && <span className="forge-develop absolute inset-0" />}
      {/* Stages 3-6: the 3D preview. */}
      {three && <canvas ref={canvasRef} className="absolute inset-0 h-full w-full [image-rendering:pixelated]" />}
      {cardArt && <img src={art} alt="" className="animate-slam absolute inset-0 h-full w-full object-contain" />}
      {/* Stage 1: the brief, typed out as a dossier while the sheet draws, then kept as the name plate. */}
      {(name || archetype) && (
        <div
          className={`absolute inset-x-0 flex flex-col gap-1 ${
            !(sheet || three) ? (stage ? 'top-16 px-4' : 'top-9 px-3') : stage ? 'bottom-0 bg-gradient-to-t from-ink/90 via-ink/50 to-transparent px-4 pb-4 pt-12' : 'bottom-0 px-3 pb-3'
          }`}
        >
          {forged && (
            <span className="animate-slam slant origin-left self-start bg-hp px-3 py-0.5 font-display text-sm uppercase text-ink [--slant:8px] sm:text-base">
              Fighter forged
            </span>
          )}
          <span
            className={`font-display uppercase leading-none tracking-tight text-paper drop-shadow-[0_2px_0_rgba(0,0,0,0.8)] ${
              stage ? 'text-[clamp(1.6rem,10cqw,3.5rem)] leading-[0.92]' : 'text-2xl sm:text-3xl'
            }`}
          >
            {name}
          </span>
          <span className={`font-cond font-bold uppercase tracking-[0.25em] text-paper/80 ${stage ? 'text-[clamp(0.75rem,3cqw,1rem)]' : 'text-xs'}`}>
            {archetype}
          </span>
          {!sheet && !three && preview?.palette && (
            <span className="mt-2 flex gap-1">
              {preview.palette.map((c) => (
                <span key={c} className={`border border-paper/30 ${stage ? 'h-5 w-9' : 'h-4 w-7'}`} style={{ background: c }} />
              ))}
            </span>
          )}
          {!sheet && !three && dossier && (
            <p
              className={`mt-2 whitespace-pre-line font-cond font-semibold uppercase leading-snug tracking-[0.08em] text-paper/75 ${
                stage ? 'text-[clamp(0.8rem,3.4cqw,1.05rem)]' : 'text-[13px]'
              }`}
            >
              {dossier}
              <span className="animate-blink">_</span>
            </p>
          )}
        </div>
      )}
      {!sheet && !three && !name && <span className="forge-develop absolute inset-0 opacity-60" />}
      <span className="forge-scanlines pointer-events-none absolute inset-0" />
      {/* The finish: a white flash as the paint lands, a sheen across the frame once it's forged. */}
      {landed >= 1 && <span key="landed" className="animate-flash pointer-events-none absolute inset-0 bg-white" />}
      {forged && (
        <span aria-hidden className="animate-shine pointer-events-none absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-white/25 to-transparent" />
      )}
    </>
  );

  if (stage) {
    return (
      <div className="flex h-full w-full items-center justify-center [container-type:size]">
        <div className="animate-slam relative" style={STAGE_FIT}>
          <div className={`cut h-full w-full p-[5px] transition-colors duration-300 [--cut:22px] ${forged ? 'bg-hp' : color}`}>
            <div className="cut relative h-full w-full overflow-hidden bg-ink [--cut:19px] [container-type:inline-size]">
              {screen}
              <div className="absolute inset-x-0 top-0 flex flex-col gap-2 bg-gradient-to-b from-ink/85 via-ink/50 to-transparent px-3 pt-3 pb-6">
                <div className="flex items-center gap-2 whitespace-nowrap">
                  <span className={`px-2 py-0.5 font-cond text-xs font-bold uppercase tracking-[0.25em] ${forged ? 'bg-hp text-ink' : 'bg-ink/80 text-paper'}`}>
                    0{index + 1} · {label}
                  </span>
                  <span className="truncate font-cond text-xs font-bold uppercase tracking-[0.2em] text-paper/75 drop-shadow-[0_1px_0_#000]">
                    {line}…
                  </span>
                </div>
                {segments}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`animate-slam flex flex-col gap-2 ${right ? 'items-end origin-right' : 'items-start origin-left'}`}>
      <div className={`cut p-[4px] transition-colors duration-300 [--cut:14px] ${forged ? 'bg-hp' : color}`}>
        {/* The show-off piece of the forging panel: as big as the player's half allows (see PREVIEW_SIZE). */}
        <div className={`cut relative aspect-[3/4] ${PREVIEW_SIZE} overflow-hidden bg-ink [--cut:12px]`}>
          {screen}
          <span className={`absolute left-2 top-2 px-2 py-0.5 font-cond text-[11px] font-bold uppercase tracking-[0.25em] ${forged ? 'bg-hp text-ink' : 'bg-ink/80 text-paper'}`}>
            0{index + 1} · {label}
          </span>
        </div>
      </div>
      {segments}
      <span className="font-cond text-sm font-bold uppercase tracking-[0.25em] text-paper/70">{line}…</span>
    </div>
  );
}
