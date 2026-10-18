import { config } from '../config';
import type { Intent } from '../intent/intents';
import type { FightEvent, PlayerId, PoseFrame } from '../types';

/**
 * Records real matches to improve the move reader: per player, every camera frame's pose points, every intent the
 * reader produced and every fight event, as JSONL in the tuner's clip format (so the existing scorers and the
 * tuner's replay read it). Uploaded to the server's /samples after each round (pose points only, never video).
 * Optionally (`?video=1`) this laptop's own camera is also recorded at low resolution and downloaded locally, so a
 * person can check what was really thrown against what the game read.
 *
 * Off unless turned on (menu toggle, saved in this browser, or `?record=1`).
 */
const KEY = 'brawlegle.record';

export function recordingEnabled() {
  const param = new URLSearchParams(window.location.search).get('record');
  if (param !== null) return param !== '0';
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function setRecordingEnabled(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? '1' : '0');
  } catch {
    // Storage blocked: the toggle lasts for this page only.
  }
}

type Line = string;
const round = (v: number) => Math.round(v * 1e4) / 1e4;
const roundLandmarks = (ls: PoseFrame['image']) => ls.map((p) => ({ x: round(p.x), y: round(p.y), z: round(p.z), visibility: round(p.visibility) }));

export class MatchRecorder {
  private lines: Record<PlayerId, Line[]> = { p1: [], p2: [] };
  private lastT: Record<PlayerId, number> = { p1: -1, p2: -1 };
  private startedAt = 0;
  private names: Record<PlayerId, string> = { p1: '', p2: '' };
  private video: { recorder: MediaRecorder; chunks: Blob[] } | null = null;
  active = false;

  /** A round starts: `who` names each player (and says if one is a CPU, which has no camera to record). */
  start(who: Record<PlayerId, { name: string; cpu: boolean }>, stream: MediaStream | null) {
    this.lines = { p1: [], p2: [] };
    this.lastT = { p1: -1, p2: -1 };
    this.startedAt = Date.now();
    this.names = { p1: who.p1.name, p2: who.p2.name };
    this.cpu = { p1: who.p1.cpu, p2: who.p2.cpu };
    this.active = true;
    if (stream && new URLSearchParams(window.location.search).get('video') === '1') this.startVideo(stream);
  }

  private cpu: Record<PlayerId, boolean> = { p1: false, p2: false };

  /** A camera frame for a player (deduped: the same frame is handed over every tick until a new one arrives). */
  frame(id: PlayerId, f: PoseFrame | null) {
    if (!this.active || !f || this.cpu[id] || f.t === this.lastT[id]) return;
    this.lastT[id] = f.t;
    this.lines[id].push(JSON.stringify({ t: round(f.t), aspect: f.aspect, image: roundLandmarks(f.image), world: roundLandmarks(f.world) }));
  }

  /** What the reader made of a player's motion (strikes, guards, cancels with their reasons...). */
  intents(id: PlayerId, list: Intent[]) {
    if (!this.active || this.cpu[id]) return;
    for (const i of list) this.lines[id].push(JSON.stringify({ intent: i }));
  }

  /** What happened in the fight (startups, hits, blocks, whiffs, K.O.), stamped with each player's latest frame time. */
  event(e: FightEvent) {
    if (!this.active) return;
    for (const id of ['p1', 'p2'] as const) if (!this.cpu[id]) this.lines[id].push(JSON.stringify({ t: this.lastT[id], event: e }));
  }

  /** The round ended: upload each recorded player's file, and save the video if one was recorded. */
  async stop(result: { winner: PlayerId | null; ending: string | null }) {
    if (!this.active) return;
    this.active = false;
    this.stopVideo();
    const stamp = new Date(this.startedAt).toISOString().replace(/[:.]/g, '-');
    for (const id of ['p1', 'p2'] as const) {
      if (this.cpu[id] || this.lines[id].length < 30) continue;
      const header = {
        clip: 'match', player: id, name: this.names[id], opponent: this.names[id === 'p1' ? 'p2' : 'p1'],
        startedAt: this.startedAt, result, frames: this.lines[id].filter((l) => l.includes('"image"')).length,
        labels: [], // unlabeled: matches are free play
      };
      const body = [JSON.stringify(header), ...this.lines[id]].join('\n') + '\n';
      try {
        const base = config.forgeApi.replace(/\/+$/, '');
        const res = await fetch(`${base}/samples`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body });
        if (!res.ok) throw new Error(`${res.status}`);
        console.info(`[record] ${id}: ${header.frames} frames saved for training`);
      } catch (err) {
        // The server's cap is 12 MB per file; anything that didn't make it is saved on this laptop instead.
        console.warn('[record] upload failed, saving locally', err);
        download(new Blob([body], { type: 'application/x-ndjson' }), `brawlegle-match-${stamp}-${id}.jsonl`);
      }
    }
  }

  private startVideo(stream: MediaStream) {
    try {
      const recorder = new MediaRecorder(stream, { mimeType: 'video/webm', videoBitsPerSecond: 400_000 });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      recorder.start(1000);
      this.video = { recorder, chunks };
    } catch (err) {
      console.warn('[record] video recording unavailable', err);
    }
  }

  private stopVideo() {
    const v = this.video;
    if (!v) return;
    this.video = null;
    const stamp = new Date(this.startedAt).toISOString().replace(/[:.]/g, '-');
    v.recorder.onstop = () => download(new Blob(v.chunks, { type: 'video/webm' }), `brawlegle-match-${stamp}.webm`);
    v.recorder.stop();
  }
}

function download(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}
