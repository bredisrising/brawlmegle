import { describe, expect, test } from 'vitest';
import { InputHub } from '../../src/input/InputHub';
import type { InputSource } from '../../src/input/InputSource';
import type { PoseFrame } from '../../src/types';

class FakeSource implements InputSource {
  readonly kind = 'remote';
  private readonly listeners = new Set<(frame: PoseFrame) => void>();
  async start() {}
  stop() {}
  onFrame(cb: (frame: PoseFrame) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  emit(t: number) {
    const frame: PoseFrame = { t, image: [], world: [] };
    this.listeners.forEach((cb) => cb(frame));
    return frame;
  }
}

describe('input hub', () => {
  test('subscribers added before a source is assigned (or across a reassign) keep getting frames', () => {
    const hub = new InputHub();
    const seen: number[] = [];
    hub.subscribe('p2', (f) => seen.push(f.t));
    const a = new FakeSource();
    hub.assign('p2', a);
    a.emit(10);
    // The client drops and rejoins: P2 gets a new source.
    const b = new FakeSource();
    hub.assign('p2', b);
    b.emit(20);
    expect(seen).toEqual([10, 20]);
  });

  test('a source whose clock restarts (peer reloaded its page) is not ignored forever', () => {
    const hub = new InputHub();
    const src = new FakeSource();
    hub.assign('p2', src);
    src.emit(600_000);
    src.emit(600_033);
    // A late, out-of-order frame is still dropped...
    src.emit(600_010);
    expect(hub.latest('p2')?.t).toBe(600_033);
    // ...but a clock that jumped back by minutes is a new session, not a late frame.
    const fresh = src.emit(1_200);
    expect(hub.latest('p2')).toBe(fresh);
    src.emit(1_233);
    expect(hub.latest('p2')?.t).toBe(1_233);
  });
});
