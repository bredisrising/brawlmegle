import { describe, expect, test } from 'vitest';
import { PersonPicker } from '../../src/input/sources/personPicker';
import type { Landmark } from '../../src/types';

const ASPECT = 4 / 3;
const DT = 1000 / 30;

/**
 * A front-facing person: shoulder center at (x, y) in image coordinates, shoulders `w` of the frame's width apart,
 * hips a torso below with visibility `hips` (MediaPipe's guess for a seated player's hips below the picture is low).
 */
function body(x: number, y: number, w: number, hips = 0.95): Landmark[] {
  const pts = Array.from({ length: 33 }, () => ({ x, y: y - w * 0.6, z: 0, visibility: 0.99 }));
  const torso = 1.3 * w * ASPECT;
  pts[11] = { x: x + w / 2, y, z: 0, visibility: 0.99 };
  pts[12] = { x: x - w / 2, y, z: 0, visibility: 0.99 };
  pts[23] = { x: x + w / 3, y: y + torso, z: 0, visibility: hips };
  pts[24] = { x: x - w / 3, y: y + torso, z: 0, visibility: hips };
  return pts;
}

/** Runs frames through a picker; each frame is a list of people, and the result is who was picked (or null). */
function run(picker: PersonPicker, frames: Landmark[][][], t0 = 0) {
  return frames.map((poses, i) => {
    const k = picker.pick(poses, t0 + i * DT, ASPECT);
    return k < 0 ? null : poses[k];
  });
}

const repeat = <T>(n: number, f: (i: number) => T) => Array.from({ length: n }, (_, i) => f(i));

// Seen on hackathon recordings: a laptop on a table, the player seated close (big, hips below the frame), a friend
// standing behind them with hips right in the middle. Picking the hips nearest the center chose the friend.
const seated = body(0.42, 0.78, 0.34, 0.1);
const standing = body(0.52, 0.32, 0.11);

describe('person picker', () => {
  test('a seated player beats a smaller person standing behind them, whichever MediaPipe lists first', () => {
    expect(run(new PersonPicker(), [[standing, seated]])[0]).toBe(seated);
    expect(run(new PersonPicker(), [[seated, standing]])[0]).toBe(seated);
  });

  test("while the player isn't found, nobody else is taken; they're picked up again when they're back", () => {
    const picker = new PersonPicker();
    const frames = [
      ...repeat(30, () => [seated, standing]),
      // The player's own detection fails (a blurred cross, both fists over the face): only the friend is found.
      ...repeat(15, () => [standing]),
      ...repeat(5, () => [standing, seated]),
    ];
    const picked = run(picker, frames);
    expect(picked.slice(0, 30).every((p) => p === seated)).toBe(true);
    expect(picked.slice(30, 45).every((p) => p === null)).toBe(true);
    expect(picked.slice(45).every((p) => p === seated)).toBe(true);
  });

  test('a friend at the same depth beside the player never takes over, even nearer the middle', () => {
    const picker = new PersonPicker();
    const player = body(0.3, 0.5, 0.2);
    const friend = body(0.56, 0.48, 0.21);
    const frames = [...repeat(10, () => [player]), ...repeat(60, (i) => (i % 2 ? [friend, player] : [player, friend])), ...repeat(10, () => [friend])];
    const picked = run(picker, frames);
    expect(picked.slice(0, 70).every((p) => p === player)).toBe(true);
    expect(picked.slice(70).every((p) => p === null)).toBe(true);
  });

  test('a fast slip or a lean is followed', () => {
    const picker = new PersonPicker();
    // Half a shoulder width a frame sideways, then leaning in (20% bigger over a few frames).
    const frames = [
      ...repeat(10, () => [body(0.5, 0.5, 0.2)]),
      ...repeat(4, (i) => [body(0.5 - 0.1 * (i + 1), 0.5, 0.2)]),
      ...repeat(4, (i) => [body(0.1, 0.5, 0.2 + 0.01 * (i + 1))]),
    ];
    expect(run(picker, frames).every((p) => p !== null)).toBe(true);
  });

  test('a garbage skeleton (head out of frame, a few times the size) is dropped', () => {
    const picker = new PersonPicker();
    const player = body(0.5, 0.5, 0.2);
    const picked = run(picker, [...repeat(10, () => [player]), [body(0.5, 0.6, 0.6)], [player]]);
    expect(picked[10]).toBeNull();
    expect(picked[11]).toBe(player);
  });

  test('someone seen only once or twice (a sliver at the edge) is forgotten quickly', () => {
    const picker = new PersonPicker();
    const sliver = body(0.99, 0.44, 0.02);
    const player = body(0.17, 0.67, 0.16);
    expect(picker.pick([sliver], 0, ASPECT)).toBe(0);
    expect(picker.pick([player], 400, ASPECT)).toBe(-1);
    expect(picker.pick([player], 600, ASPECT)).toBe(0);
  });

  test('after the player has been gone a few seconds, whoever is there is taken', () => {
    const picker = new PersonPicker();
    run(picker, repeat(10, () => [seated]));
    // Over 3 s later: the player left, someone else sat down at the side.
    const next = body(0.85, 0.6, 0.25);
    expect(picker.pick([next], 9 * DT + 2900, ASPECT)).toBe(-1);
    expect(picker.pick([next], 9 * DT + 3100, ASPECT)).toBe(0);
  });

  test('someone much bigger for a second and a half takes over (the player sat down after the camera started)', () => {
    const picker = new PersonPicker();
    const frames = [...repeat(20, () => [standing]), ...repeat(60, () => [standing, seated])];
    const picked = run(picker, frames);
    expect(picked.slice(0, 20).every((p) => p === standing)).toBe(true);
    const first = picked.indexOf(seated);
    expect((first - 20) * DT).toBeGreaterThanOrEqual(1500);
    expect((first - 21) * DT).toBeLessThan(1500);
    expect(picked.slice(first).every((p) => p === seated)).toBe(true);
  });

  test("one pose at a time (one-pose mode): a pose that isn't where the player was is dropped", () => {
    const picker = new PersonPicker();
    run(picker, repeat(10, () => [seated]));
    expect(picker.pick([standing], 10 * DT, ASPECT)).toBe(-1);
    expect(picker.pick([seated], 11 * DT, ASPECT)).toBe(0);
    expect(picker.seenAt).toBe(11 * DT);
  });

  test('poses without shoulders, or with broken numbers, are skipped', () => {
    const picker = new PersonPicker();
    const broken = body(0.5, 0.5, 0.2);
    broken[11] = { ...broken[11], x: NaN };
    expect(picker.pick([broken, [], seated], 0, ASPECT)).toBe(2);
  });
});
