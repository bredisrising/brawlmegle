export type TrackerKind = 'mock' | 'mediapipe';

const params = new URLSearchParams(window.location.search);

export const config = {
  /** Which pose tracker drives the fighters. `?tracker=mediapipe` overrides the env var. */
  tracker: (params.get('tracker') ?? import.meta.env.VITE_TRACKER ?? 'mock') as TrackerKind,
  /** Backend that proxies OpenAI / image-to-3D. Empty means the forge pipeline uses mocks. */
  forgeApi: (import.meta.env.VITE_FORGE_API as string | undefined) ?? '',
};
