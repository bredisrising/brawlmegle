import type { ForgedFighter, ForgePreview } from '../types';
import type { ScanProgress } from './scanBuckets';

/** Player-facing text for scan and forge progress (statusDetail on the lobby / client screens). */

export const FORGE_STEPS: Record<NonNullable<ForgedFighter['step']>, string> = {
  brief: 'Sizing you up',
  sheet: 'Drawing your fighter',
  model: 'Building your 3D model',
  cleanup: 'Polishing',
  rig: 'Rigging your fighter',
};

const TICK = ['·', '½', '✓'] as const;

/** "Turn slowly to your left… front ✓ left · right ½" */
export function scanStatus(p: ScanProgress): string {
  const b = p.buckets;
  return `${p.hint}  front ${TICK[b.front.tier]} left ${TICK[b.left.tier]} right ${TICK[b.right.tier]}`;
}

export function forgeStatus(f: ForgedFighter): string {
  if (f.status === 'failed') return 'Forge failed, using a stock fighter';
  if (f.status === 'ready') return 'Fighter ready';
  return f.step ? FORGE_STEPS[f.step] : 'Forging your fighter';
}

/** Wraps a setter so it only fires when the text changes (scan progress arrives every camera frame). */
export function onChange(set: (text: string) => void): (text: string) => void {
  let last: string | null = null;
  return (text) => {
    if (text !== last) set((last = text));
  };
}

/** The live preview's stages from a forge status: whatever exists so far (the GPU box streams voxels and clay). */
export function forgePreview(f: ForgedFighter): ForgePreview {
  const brief = f.brief ?? {};
  const text = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : []);
  const dossier = [
    text(brief.build) && `Build: ${brief.build}`,
    list(brief.signature).length ? `Signature: ${list(brief.signature).join(', ')}` : undefined,
    text(brief.prop) && `Prop: ${brief.prop}`,
    text(brief.scout_report),
  ].filter((x): x is string => Boolean(x));
  const palette = list(brief.palette).filter((c) => /^#[0-9a-f]{6}$/i.test(c));
  const preview: ForgePreview = {
    name: text(brief.name),
    archetype: text(brief.archetype),
    dossier: dossier.length ? dossier : undefined,
    palette: palette.length ? palette : undefined,
    sheetUrl: f.sheetUrl ?? f.sheetPartialUrl,
    sheetFinal: f.sheetUrl ? true : undefined,
    voxelsUrl: f.previewVoxelsUrl,
    meshUrl: f.previewMeshUrl,
    step: f.step,
  };
  for (const key of Object.keys(preview) as (keyof ForgePreview)[]) if (preview[key] === undefined) delete preview[key];
  return preview;
}

/** Same preview? (The forge's status arrives every 1.5 s; the store only changes when the preview does.) */
export function samePreview(a: ForgePreview | null, b: ForgePreview | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
