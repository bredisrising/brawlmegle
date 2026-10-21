import type { PlayerId, PoseFrame } from '../types';
import type { InputSource } from './InputSource';

/** A frame this much older than the newest one isn't late (poses are never retransmitted): the source's clock restarted. */
const CLOCK_RESET_MS = 5000;
/** Frames kept for take() between calls: a second or two of poses (nobody's taking them in a background tab). */
const MAX_WAITING = 60;

/** Assigns input sources to fighters and keeps their newest pose frame (and the ones that arrived since take()). */
export class InputHub {
  private readonly sources = new Map<PlayerId, InputSource>();
  private readonly frames = new Map<PlayerId, PoseFrame>();
  private readonly waiting = new Map<PlayerId, PoseFrame[]>();
  private readonly stopListening = new Map<PlayerId, () => void>();
  private readonly subscribers = new Map<PlayerId, Set<(frame: PoseFrame) => void>>();

  assign(player: PlayerId, source: InputSource): void {
    this.unassign(player);
    this.sources.set(player, source);
    this.stopListening.set(player, source.onFrame((frame) => {
      const previous = this.frames.get(player);
      if (previous && frame.t < previous.t && previous.t - frame.t < CLOCK_RESET_MS) return;
      this.frames.set(player, frame);
      const waiting = this.waiting.get(player) ?? [];
      if (waiting.push(frame) > MAX_WAITING) waiting.shift();
      this.waiting.set(player, waiting);
      this.subscribers.get(player)?.forEach((cb) => cb(frame));
    }));
  }

  unassign(player: PlayerId): void {
    this.stopListening.get(player)?.();
    this.stopListening.delete(player);
    this.sources.delete(player);
    this.frames.delete(player);
    this.waiting.delete(player);
    // Subscribers stay: they follow the player, whichever source feeds them.
  }

  latest(player: PlayerId): PoseFrame | null {
    return this.frames.get(player) ?? this.sources.get(player)?.latestFrame ?? null;
  }

  /**
   * Every frame that arrived for a player since the last call, oldest first. The game ticks off animation frames, so
   * after a render hitch several poses wait at once: reading only the newest would drop the others (and any punch in
   * them).
   */
  take(player: PlayerId): PoseFrame[] {
    const waiting = this.waiting.get(player);
    if (!waiting?.length) return [];
    this.waiting.set(player, []);
    return waiting;
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
