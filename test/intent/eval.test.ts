// Accuracy of the intent reader on synthetic clips. Prints a report; fails if it drops below the floor.
import { expect, test } from 'vitest';
import { evaluateSynthetic, report } from './eval';

// Floors are where the reader is today, so regressions fail. Raise them as it improves.
const CASES = [
  { title: 'facing the camera', cameraYaw: 0, noise: 1, floor: 0.88, precision: 0.78 },
  { title: 'camera 45° to the side', cameraYaw: 45, noise: 1, floor: 0.85, precision: 0.75 },
  { title: 'facing, bad lighting', cameraYaw: 0, noise: 2, floor: 0.75, precision: 0.68 },
];

for (const c of CASES) {
  test(c.title, () => {
    const result = evaluateSynthetic({ cameraYaw: c.cameraYaw, noise: c.noise, seeds: [1, 2, 3] });
    console.log('\n' + report(result, c.title));
    expect(result.recall).toBeGreaterThan(c.floor);
    expect(result.precision).toBeGreaterThan(c.precision);
  }, 30_000);
}
