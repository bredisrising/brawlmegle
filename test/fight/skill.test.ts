// Skill vs volume through the real engine, with the camera's real flaws (see skill.ts). VERBOSE=1 prints the table.
import { expect, test } from 'vitest';
import { GOOD, REAL, boxer, formatMatchup, masher, matchup, patient, turtle } from './skill';

test('skill beats volume', () => {
  const pairs = [
    [() => patient(), () => masher(3)],
    [() => boxer(), () => masher(3)],
    [() => turtle(), () => masher(3)],
    [() => patient(), () => masher(2)],
    [() => boxer(), () => masher(2)],
    [() => masher(3), () => masher(1.5)],
    [() => masher(2), () => masher(2)],
    [() => boxer(), () => patient()],
    [() => boxer(), () => turtle()],
    [() => patient(), () => turtle()],
  ] as const;
  const rows = pairs.map(([a, b]) => matchup(a, b, 40, REAL));
  const good = pairs.map(([a, b]) => matchup(a, b, 40, GOOD));
  if (process.env.VERBOSE) console.log(`\nreads as today\n${rows.map((m) => formatMatchup(m)).join('\n')}\n\nnearly every punch read\n${good.map((m) => formatMatchup(m)).join('\n')}`);
  const vs = (a: string, b: string, set = good) => set.find((m) => m.a === a && m.b === b)!;
  // Floors a little under where it is now. With nearly every punch read (where tracking is going), patience still beats
  // a masher, and a deliberate guard isn't hopeless against one; mashing more than the other masher still pays.
  expect(vs('patient', 'masher 3/s').winsA).toBeGreaterThanOrEqual(30);
  expect(vs('turtle', 'masher 3/s').winsA).toBeGreaterThanOrEqual(18);
  expect(vs('patient', 'turtle').winsA).toBeGreaterThanOrEqual(28);
  expect(vs('masher 3/s', 'masher 1.5/s').winsA).toBeGreaterThanOrEqual(28);
  // A fight still ends: two mashers finish well inside a minute.
  expect(vs('masher 2/s', 'masher 2/s', rows).seconds).toBeLessThan(40);
});
