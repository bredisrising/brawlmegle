/**
 * "Forge" pipeline: scan the player -> exaggerated street-fighter hero image -> 3D model.
 *
 * API keys must NOT live in the browser. Each step should call our own backend
 * (config.forgeApi), which proxies OpenAI image gen and the image-to-3D service.
 * Until that exists, every step is mocked.
 */

export interface ForgedFighter {
  /** Reference hero image (ChatGPT image output). */
  heroImageUrl: string | null;
  /** Rigged/riggable 3D model URL (GLB) from the image-to-3D service. */
  modelUrl: string | null;
}

export type ForgeProgress = (step: string) => void;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** TODO: capture 3 frames (front / side / back) while the player turns 360° in front of the camera. */
export async function captureScanImages(): Promise<Blob[]> {
  await wait(800);
  return [];
}

/** TODO: POST scan images to `${config.forgeApi}/hero` -> OpenAI image edit -> hero image URL. */
export async function generateHeroImage(_scans: Blob[]): Promise<string | null> {
  await wait(800);
  return null;
}

/** TODO: POST hero image to `${config.forgeApi}/model` -> image-to-3D -> GLB URL. */
export async function generateModel(_heroImageUrl: string | null): Promise<string | null> {
  await wait(800);
  return null;
}

export async function forgeFighter(onProgress: ForgeProgress): Promise<ForgedFighter> {
  onProgress('Scanning body');
  const scans = await captureScanImages();
  onProgress('Forging hero');
  const heroImageUrl = await generateHeroImage(scans);
  onProgress('Building 3D model');
  const modelUrl = await generateModel(heroImageUrl);
  return { heroImageUrl, modelUrl };
}
