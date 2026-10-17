export type InputKind = 'mock' | 'camera';

const params = new URLSearchParams(window.location.search);
const env = import.meta.env;
const turnUrl = env.VITE_TURN_URL as string | undefined;

export const config = {
  /** Source for the player tracked on this machine. `?input=camera` overrides the env var. */
  input: (params.get('input') ?? import.meta.env.VITE_INPUT ?? 'mock') as InputKind,
  /** AWS signaling server (WebSocket) that brokers the P2P handshake. */
  signalUrl: (import.meta.env.VITE_SIGNAL_URL as string | undefined) ?? 'wss://54-149-60-196.sslip.io/ws',
  /** STUN + optional TURN (coturn on the signaling box) for venue Wi-Fi that blocks direct P2P. */
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    ...(turnUrl ? [{ urls: turnUrl, username: env.VITE_TURN_USER as string, credential: env.VITE_TURN_PASS as string }] : []),
  ] as RTCIceServer[],
  /** Forge server: shared, so a username's fighter is the same on every laptop. VITE_FORGE_API= (empty) mocks it. */
  forgeApi: (import.meta.env.VITE_FORGE_API as string | undefined) ?? 'https://54-149-60-196.sslip.io',
  /**
   * Sent with forge requests so random people can't spend our image/3D credits through the public endpoint.
   * Not a real secret (it ships in the page); the server also caps forges per hour and per day.
   */
  forgeKey: (import.meta.env.VITE_FORGE_KEY as string | undefined) ?? '720f66ea6f3cebda14050f8fa706cc1a',
};
