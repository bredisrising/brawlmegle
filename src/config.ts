export type InputKind = 'mock' | 'camera';

const params = new URLSearchParams(window.location.search);

export const config = {
  /** Source for the player tracked on this machine. `?input=camera` overrides the env var. */
  input: (params.get('input') ?? import.meta.env.VITE_INPUT ?? 'mock') as InputKind,
  /** AWS signaling server (WebSocket) that brokers the P2P handshake. */
  signalUrl: (import.meta.env.VITE_SIGNAL_URL as string | undefined) ?? '',
  /** Forge server. Empty means the forge pipeline uses mocks. */
  forgeApi: (import.meta.env.VITE_FORGE_API as string | undefined) ?? '',
};
