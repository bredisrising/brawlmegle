export type InputKind = 'mock' | 'camera';
export type PoseModel = 'lite' | 'full';

const params = new URLSearchParams(window.location.search);
const env = import.meta.env;
const turnUrl = env.VITE_TURN_URL as string | undefined;
const requestedPoseModel = params.get('poseModel') ?? import.meta.env.VITE_POSE_MODEL;
const requestedPoseCount = Number(params.get('poseCount') ?? import.meta.env.VITE_POSE_COUNT ?? 1);

export const config = {
  /** Source for the player tracked on this machine. `?input=camera` overrides the env var. */
  input: (params.get('input') ?? import.meta.env.VITE_INPUT ?? 'mock') as InputKind,
  /** Lite favors fast response. Full is steadier in difficult lighting at a higher compute cost. */
  poseModel: requestedPoseModel === 'full' ? 'full' : 'lite' as PoseModel,
  /** One person per camera is fastest; use 2 only when a camera deliberately covers two people. */
  poseCount: Number.isFinite(requestedPoseCount) ? Math.max(1, Math.min(2, Math.round(requestedPoseCount))) : 1,
  /** AWS signaling server (WebSocket) that brokers the P2P handshake. */
  signalUrl: (import.meta.env.VITE_SIGNAL_URL as string | undefined) ?? '',
  /** STUN + optional TURN (coturn on the signaling box) for venue Wi-Fi that blocks direct P2P. */
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    ...(turnUrl ? [{ urls: turnUrl, username: env.VITE_TURN_USER as string, credential: env.VITE_TURN_PASS as string }] : []),
  ] as RTCIceServer[],
  /** Forge server. Empty means the forge pipeline uses mocks. */
  forgeApi: (import.meta.env.VITE_FORGE_API as string | undefined) ?? '',
};
