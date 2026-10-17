import type { ForgedFighter } from '../types';

/**
 * Forge client: 3 scan frames + name -> forged fighter.
 *
 * Capture runs on whichever laptop tracks the player. A client laptop sends its
 * frames to the host over P2P; only the host talks to the forge server and keeps fighters.
 * API keys live on the forge server, never in the browser.
 *
 *   POST /api/forge      { name, frames: [front, left, right] }  ->  { id }
 *   GET  /api/forge/:id  ->  ForgedFighter
 *
 * Every step is mocked until the server exists (config.forgeApi empty).
 */

export type ScanFrames = [front: string, left: string, right: string]; // base64 JPEGs

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs while the player turns 360° in front of their camera.
 * TODO: bucket frames by facing (shoulder width + nose offset), keep the sharpest per bucket.
 */
export async function captureScan(_video: HTMLVideoElement | undefined): Promise<ScanFrames> {
  await wait(800);
  return ['', '', ''];
}

/** TODO: POST to `${config.forgeApi}/api/forge`. */
export async function submitForge(_name: string, _frames: ScanFrames): Promise<string> {
  await wait(300);
  return `mock-${Date.now()}`;
}

/** TODO: GET `${config.forgeApi}/api/forge/:id`. */
export async function getForge(id: string, name: string): Promise<ForgedFighter> {
  await wait(1200);
  return { id, name, status: 'ready' };
}
