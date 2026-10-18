import { config } from '../config';
import { useGameStore } from './store';
import type { Intent } from '../intent/intents';
import type { FightEvent, PlayerId, PoseFrame } from '../types';

/**
 * Records real matches to improve the move reader: per player, every camera frame's pose points, every intent the
 * reader produced and every fight event, as JSONL in the tuner's clip format (so the existing scorers and the
 * tuner's replay read it). Uploaded to the server's /samples after each round (pose points only).
 * Only with `?video=1` (the team's own sessions) is this laptop's camera also recorded, at low resolution, and
 * uploaded to /samples/video (saved locally if that fails), so what was really thrown can be checked against what
 * the game read.
 *
 * Off by default now that the site is public: the team turns it on for its own sessions with `?record=1` or the
 * menu toggle (saved in this browser).
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

const VIDEO_KEY = 'brawlegle.video';

/**
 * Camera video with the recording: off by default (a stranger's camera isn't covered by a scan's consent); the team
 * turns it on for its own sessions with `?video=1` or the menu toggle. A REC dot shows while it records.
 */
export function videoEnabled() {
  const param = new URLSearchParams(window.location.search).get('video');
  if (param !== null) return param !== '0';
  try {
    return localStorage.getItem(VIDEO_KEY) === '1';
  } catch {
    return false;
  }
}

export function setVideoEnabled(on: boolean) {
  try {
    localStorage.setItem(VIDEO_KEY, on ? '1' : '0');
  } catch {
    // Storage blocked: the toggle lasts for this page only.
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
  private video: { recorder: MediaRecorder; chunks: Blob[]; track: MediaStreamTrack | null } | null = null;
  active = false;

  /** A round starts: `who` names each player (and says if one is a CPU, which has no camera to record). */
  start(who: Record<PlayerId, { name: string; cpu: boolean }>, stream: MediaStream | null) {
    this.lines = { p1: [], p2: [] };
    this.lastT = { p1: -1, p2: -1 };
    this.startedAt = Date.now();
    this.names = { p1: who.p1.name, p2: who.p2.name };
    this.cpu = { p1: who.p1.cpu, p2: who.p2.cpu };
    this.active = true;
    if (stream && videoEnabled()) this.startVideo(stream);
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
        download(new Blob([body], { type: 'application/x-ndjson' }), `brawlmegle-match-${stamp}-${id}.jsonl`);
      }
    }
  }

  /** The round was called off (a player walked away): keep nothing. */
  discard() {
    if (!this.active) return;
    this.active = false;
    const v = this.video;
    this.video = null;
    if (!v) return;
    useGameStore.setState({ recordingVideo: false });
    v.recorder.onstop = () => v.track?.stop();
    v.recorder.stop();
  }

  private startVideo(stream: MediaStream) {
    try {
      const { recorder, track } = cameraRecorder(stream);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      recorder.start(1000);
      this.video = { recorder, chunks, track };
      useGameStore.setState({ recordingVideo: true });
    } catch (err) {
      console.warn('[record] video recording unavailable', err);
    }
  }

  private stopVideo() {
    const v = this.video;
    if (!v) return;
    this.video = null;
    useGameStore.setState({ recordingVideo: false });
    const stamp = new Date(this.startedAt).toISOString().replace(/[:.]/g, '-');
    v.recorder.onstop = () => {
      v.track?.stop();
      void uploadVideo(new Blob(v.chunks, { type: 'video/webm' }), `brawlmegle-match-${stamp}-p1.webm`);
    };
    v.recorder.stop();
  }
}

/**
 * Just this laptop's camera, low resolution, saved to Downloads when stopped (`?video=1`): the client laptop uses it
 * so both players' rounds can be checked against what the game read.
 */
export class VideoClip {
  private rec: { recorder: MediaRecorder; chunks: Blob[]; started: number; track: MediaStreamTrack | null } | null = null;

  start(stream: MediaStream | null) {
    if (!stream || this.rec || !videoEnabled()) return;
    try {
      const { recorder, track } = cameraRecorder(stream);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      recorder.start(1000);
      this.rec = { recorder, chunks, started: Date.now(), track };
      useGameStore.setState({ recordingVideo: true });
    } catch (err) {
      console.warn('[record] video recording unavailable', err);
    }
  }

  stop(tag: string) {
    const r = this.rec;
    if (!r) return;
    this.rec = null;
    useGameStore.setState({ recordingVideo: false });
    const stamp = new Date(r.started).toISOString().replace(/[:.]/g, '-');
    r.recorder.onstop = () => {
      r.track?.stop();
      void uploadVideo(new Blob(r.chunks, { type: 'video/webm' }), `brawlmegle-match-${stamp}-${tag}.webm`);
    };
    r.recorder.stop();
  }
}

/**
 * A light recorder for the camera: a copy of its track scaled to at most 360 px tall at 15 fps (the browser scales
 * and drops frames in its capture pipeline; the game's own track is untouched), VP8 at 250 kbps. Recording the camera
 * as it is (up to 960x720 at 30 fps) cost an integrated GPU laptop ~4 of its ~24 poses a second; this is still
 * plenty to label strikes by eye.
 */
function cameraRecorder(stream: MediaStream): { recorder: MediaRecorder; track: MediaStreamTrack | null } {
  const source = stream.getVideoTracks()[0];
  const track = source ? source.clone() : null;
  if (track) {
    track
      .applyConstraints({ height: { max: 360 }, frameRate: { max: 15 }, resizeMode: 'crop-and-scale' } as MediaTrackConstraints)
      .catch((err) => console.warn('[record] could not shrink the video track, recording it as is', err));
  }
  const mimeType = ['video/webm;codecs=vp8', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t));
  try {
    const recorder = new MediaRecorder(track ? new MediaStream([track]) : stream, { mimeType, videoBitsPerSecond: 250_000 });
    return { recorder, track };
  } catch (err) {
    track?.stop();
    throw err;
  }
}

/** A round's video to the server for training (the laptop opted in with ?video=1); kept locally if that fails. */
async function uploadVideo(blob: Blob, name: string) {
  try {
    const base = config.forgeApi.replace(/\/+$/, '');
    const res = await fetch(`${base}/samples/video?name=${encodeURIComponent(name.replace(/\.webm$/, ''))}`, {
      method: 'POST',
      headers: { 'content-type': 'video/webm' },
      body: blob,
    });
    if (!res.ok) throw new Error(`${res.status}`);
    console.info(`[record] video ${name} saved for training`);
  } catch (err) {
    console.warn('[record] video upload failed, saving locally', err);
    download(blob, name);
  }
}

function download(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}
