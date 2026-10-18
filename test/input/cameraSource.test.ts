import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { PoseFrame } from '../../src/types';

// CameraSource only needs a video element and MediaPipe at runtime; fake both so the frame loop runs in node.
vi.mock('@mediapipe/tasks-vision', () => ({ FilesetResolver: {}, PoseLandmarker: {} }));

const frameCallbacks: ((now: number, meta: object) => void)[] = [];
const video = {
  readyState: 4,
  videoWidth: 640,
  videoHeight: 480,
  requestVideoFrameCallback: (cb: (now: number, meta: object) => void) => frameCallbacks.push(cb),
};

let CameraSource: typeof import('../../src/input/sources/CameraSource').CameraSource;
beforeAll(async () => {
  vi.stubGlobal('window', { location: { search: '' } });
  vi.stubGlobal('document', { createElement: () => video });
  vi.stubGlobal('HTMLMediaElement', { HAVE_CURRENT_DATA: 2 });
  ({ CameraSource } = await import('../../src/input/sources/CameraSource'));
});

const pose = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 1 }));

describe('CameraSource frame loop', () => {
  it('keeps tracking after a detection error or a throwing listener', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const camera = new CameraSource();
    let fail = true;
    const landmarker = {
      detectForVideo: () => {
        if (fail) throw new Error('GPU hiccup');
        return { landmarks: [pose], worldLandmarks: [pose] };
      },
    };
    // Skip start() (getUserMedia + model download): mark it running and kick the loop by hand.
    Object.assign(camera as unknown as Record<string, unknown>, { running: true, landmarker });
    (camera as unknown as { schedule(): void }).schedule();

    frameCallbacks.shift()!(16, {});
    expect(frameCallbacks).toHaveLength(1); // rescheduled despite the throw

    fail = false;
    const got: PoseFrame[] = [];
    camera.onFrame(() => {
      throw new Error('data channel closing');
    });
    camera.onFrame((frame) => got.push(frame));
    frameCallbacks.shift()!(33, {});
    expect(got).toHaveLength(1); // the second listener still got the frame
    expect(frameCallbacks).toHaveLength(1); // and the loop goes on
    expect(camera.tracking).toBe(true);
  });
});
