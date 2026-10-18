import { useEffect, useRef, useState } from 'react';
import { config } from '../config';
import { preloadModel } from '../forge/models';
import { createForgePreview } from './forgePreview3d';

/** A forged fighter as the showcase needs it (from GET /api/fighters, raw: the preview files and brief included). */
type Showcased = { id: string; name: string; archetype: string; glbUrl: string; voxels?: string; mesh?: string };

const api = () => config.forgeApi.replace(/\/+$/, '');
const absolute = (url: unknown) => (typeof url !== 'string' || !url ? undefined : url.startsWith('/') ? `${api()}${url}` : url);

async function fetchShowcase(): Promise<Showcased[]> {
  if (!config.forgeApi) return [];
  try {
    const res = await fetch(`${api()}/api/fighters`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return [];
    const list = (await res.json()) as Record<string, unknown>[];
    const out = list.flatMap((f): Showcased[] => {
      const glbUrl = absolute(f.glbUrl);
      if (!glbUrl?.includes('/api/forge/') || f.status !== 'ready') return [];
      const brief = (f.brief ?? {}) as { archetype?: unknown };
      return [{
        id: String(f.id),
        name: String(f.name ?? ''),
        archetype: typeof brief.archetype === 'string' ? brief.archetype : '',
        glbUrl,
        voxels: absolute(f.previewVoxelsUrl),
        mesh: absolute(f.previewMeshUrl),
      }];
    });
    // A different order each visit (the first one shown is whoever's luck it is).
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  } catch {
    return [];
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * "Choose your fighter": the memory card's forged fighters on a turntable, one after another, each built up the way
 * the live forge preview builds a new one (voxel hologram, clay, then the paint sweep and the rig flash; fighters
 * from before the GPU forge have no intermediates and just paint in). Nothing shows without a forge server.
 */
export function FighterShowcase({ color, hex, other }: { color: string; hex: string; other: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [fighters, setFighters] = useState<Showcased[]>([]);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    let alive = true;
    void fetchShowcase().then((list) => alive && setFighters(list));
    return () => {
      alive = false;
    };
  }, []);

  const fighter = fighters.length ? fighters[index % fighters.length] : null;
  useEffect(() => {
    if (!fighter || !canvasRef.current) return;
    const view = createForgePreview(canvasRef.current, hex, other, config.lowPower);
    let alive = true;
    void (async () => {
      if (fighter.voxels) {
        await view.showVoxels(fighter.voxels).catch(() => {});
        await wait(1300);
      }
      if (alive && fighter.mesh) {
        await view.showClay(fighter.mesh).catch(() => {});
        await wait(1300);
      }
      if (alive) await view.showFinal(fighter.glbUrl).catch(() => {});
    })();
    // The next one's model downloads while this one turns.
    if (fighters.length > 1) preloadModel(fighters[(index + 1) % fighters.length].glbUrl);
    const next = window.setTimeout(() => setIndex((i) => i + 1), fighter.voxels ? 8500 : 6000);
    return () => {
      alive = false;
      window.clearTimeout(next);
      view.dispose();
    };
  }, [fighter, fighters, index, hex, other]);

  if (!fighter) return null;
  return (
    <div className="animate-rise flex flex-col items-center gap-2 [animation-delay:260ms]">
      <div className={`cut ${color} p-[4px] [--cut:16px]`}>
        <div className="cut relative aspect-[3/4] h-[min(62vh,600px)] overflow-hidden bg-ink [--cut:14px]">
          <canvas key={fighter.id} ref={canvasRef} className="absolute inset-0 h-full w-full [image-rendering:pixelated]" />
          <span className="forge-scanlines pointer-events-none absolute inset-0" />
          <span className="absolute left-2 top-2 bg-ink/80 px-2 py-0.5 font-cond text-[11px] font-bold uppercase tracking-[0.25em] text-paper">
            Memory card · {String((index % fighters.length) + 1).padStart(2, '0')}/{String(fighters.length).padStart(2, '0')}
          </span>
          <div key={`${fighter.id}-name`} className="animate-in-l absolute inset-x-4 bottom-4 flex flex-col gap-1">
            <span className="truncate font-display text-3xl uppercase leading-none tracking-tight text-paper drop-shadow-[0_2px_0_rgba(0,0,0,0.8)] sm:text-4xl">
              {fighter.name}
            </span>
            {fighter.archetype && (
              <span className="truncate font-cond text-xs font-bold uppercase tracking-[0.25em] text-paper/80">{fighter.archetype}</span>
            )}
          </div>
        </div>
      </div>
      <span className="font-cond text-sm font-bold uppercase tracking-[0.25em] text-paper/60">Forged from a webcam scan</span>
    </div>
  );
}
