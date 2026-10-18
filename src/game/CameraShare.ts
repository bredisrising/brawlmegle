import type { Peer } from '../net/Peer';
import { useGameStore } from './store';

/**
 * What the opponent-camera frame shows, from the two players' "Hide my camera" choices (the owner's rule: if either
 * player hides, neither sees the other), and whether this laptop's camera goes out.
 */
export type CamView = {
  /** Show the opponent's video (it may still be connecting). */
  show: boolean;
  /** This laptop's camera goes to the opponent. */
  sending: boolean;
  /** What the frame says instead of the video, if anything. */
  label: string | null;
};

export function camView(s: { camHidden: boolean; opponentCamHidden: boolean; opponentVideo: MediaStream | null; camSending: boolean }): CamView {
  if (s.camHidden) return { show: false, sending: false, label: 'You hid your camera' };
  if (s.opponentCamHidden) return { show: false, sending: false, label: 'Your opponent hid their camera' };
  return { show: !!s.opponentVideo, sending: s.camSending, label: s.opponentVideo ? null : 'Connecting camera…' };
}

/** The light copy of the camera that goes to the opponent: the pose tracker keeps the full-rate original. */
const LIGHT: MediaTrackConstraints = {
  width: { max: 320 },
  height: { max: 240 },
  frameRate: { max: 15 },
  resizeMode: 'crop-and-scale',
} as MediaTrackConstraints;

/**
 * The two players see each other's camera (Omegle style). This laptop sends a small copy of its camera on the
 * connection's video transceiver (Peer.setVideo), and shows the other's in the opponent frame (ui/OpponentCam).
 * "Hide my camera" stops both: this laptop stops sending, the opponent is told (a `cam` message) and stops sending
 * too, and neither shows the other's.
 */
export class CameraShare {
  private peer: Peer | null = null;
  private tell: ((hidden: boolean) => void) | null = null;
  private offPeer: (() => void) | null = null;
  private stream: MediaStream | null = null;
  private light: MediaStreamTrack | null = null;
  private readonly unsubscribe: () => void;

  constructor() {
    this.unsubscribe = useGameStore.subscribe((s, prev) => {
      if (s.camHidden !== prev.camHidden) this.tell?.(s.camHidden);
      if (s.camHidden !== prev.camHidden || s.opponentCamHidden !== prev.opponentCamHidden) this.sync();
    });
  }

  /** The connection to the opponent (null: none). `tell` sends them this laptop's hide-camera choice. */
  attach(peer: Peer | null, tell: ((hidden: boolean) => void) | null) {
    if (peer === this.peer) {
      this.tell = tell;
      return;
    }
    this.offPeer?.();
    this.peer?.setVideo(null);
    this.peer = peer;
    this.tell = tell;
    this.offPeer = peer?.onRemoteVideo(() => this.sync()) ?? null;
    useGameStore.setState({ opponentCamHidden: false });
    this.sync();
  }

  /** The (new) opponent is connected: tell them whether this laptop hides its camera. */
  connected() {
    useGameStore.setState({ opponentCamHidden: false });
    this.tell?.(useGameStore.getState().camHidden);
    this.sync();
  }

  /** The opponent's hide-camera choice arrived. */
  remoteHidden(hidden: boolean) {
    useGameStore.setState({ opponentCamHidden: hidden });
  }

  /** This laptop's camera (null when there's none, e.g. the mock input). Cheap to call every frame. */
  camera(stream: MediaStream | null) {
    if (stream === this.stream) return;
    this.stream = stream;
    this.light?.stop();
    this.light = null;
    const track = stream?.getVideoTracks()[0];
    if (track) {
      this.light = track.clone();
      // The browser scales and drops frames in its capture pipeline: the encoder only ever sees the small copy.
      this.light.applyConstraints(LIGHT).catch((err) => console.warn('[cam] could not shrink the camera copy', err));
    }
    this.sync();
  }

  private sync() {
    const { camHidden, opponentCamHidden } = useGameStore.getState();
    const share = !camHidden && !opponentCamHidden;
    this.peer?.setVideo(share ? this.light : null);
    const opponentVideo = share ? this.peer?.remoteVideo ?? null : null;
    const camSending = share && !!this.light && !!this.peer?.connected;
    const s = useGameStore.getState();
    if (s.opponentVideo !== opponentVideo || s.camSending !== camSending) useGameStore.setState({ opponentVideo, camSending });
  }

  /** Re-check after the connection opens or closes (Peer has no event for "connected" the share listens to). */
  refresh() {
    this.sync();
  }

  dispose() {
    this.unsubscribe();
    this.attach(null, null);
    this.light?.stop();
    this.light = null;
  }
}
