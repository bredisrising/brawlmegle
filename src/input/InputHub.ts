import type { PlayerId, PoseFrame } from '../types';
import type { InputSource } from './InputSource';

/** Assigns input sources to fighters and keeps their newest pose frame. */
export class InputHub {
  private readonly sources = new Map<PlayerId, InputSource>();
  private readonly frames = new Map<PlayerId, PoseFrame>();
  private readonly stopListening = new Map<PlayerId, () => void>();
  private readonly subscribers = new Map<PlayerId, Set<(frame: PoseFrame) => void>>();

  assign(player: PlayerId, source: InputSource): void {
    this.unassign(player);
    this.sources.set(player, source);
    this.subscribers.set(player, new Set());
    this.stopListening.set(player, source.onFrame((frame) => {
      const previous = this.frames.get(player);
      if (previous && frame.t < previous.t) return;
      this.frames.set(player, frame);
      this.subscribers.get(player)?.forEach((cb) => cb(frame));
    }));
  }

  unassign(player: PlayerId): void {
    this.stopListening.get(player)?.();
    this.stopListening.delete(player);
    this.sources.delete(player);
    this.frames.delete(player);
    this.subscribers.delete(player);
  }

  latest(player: PlayerId): PoseFrame | null {
    return this.frames.get(player) ?? this.sources.get(player)?.latestFrame ?? null;
  }

  source(player: PlayerId): InputSource | null {
    return this.sources.get(player) ?? null;
  }

  subscribe(player: PlayerId, cb: (frame: PoseFrame) => void): () => void {
    const listeners = this.subscribers.get(player) ?? new Set<(frame: PoseFrame) => void>();
    listeners.add(cb);
    this.subscribers.set(player, listeners);
    return () => listeners.delete(cb);
  }
}
