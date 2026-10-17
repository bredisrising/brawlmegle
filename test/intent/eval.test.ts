// Accuracy of the intent reader on synthetic clips. Prints a report; fails if it drops below the floor.
import { expect, test } from 'vitest';
import { evaluateSynthetic, report } from './eval';

const CASES = [
  { title: 'facing the camera', cameraYaw: 0, noise: 1 },
  { title: 'camera 45° to the side', cameraYaw: 45, noise: 1 },
  { title: 'facing, bad lighting', cameraYaw: 0, noise: 2 },
];

for (const c of CASES) {
  test(c.title, () => {
    const result = evaluateSynthetic({ cameraYaw: c.cameraYaw, noise: c.noise, seeds: [1, 2, 3] });
    console.log('\n' + report(result, c.title));
    expect(result.recall).toBeGreaterThan(0.5);
  });
}
