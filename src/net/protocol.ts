import type { FightEvent, FighterState, ForgedFighter, ForgePreview, Hand, Phase, PlayerId, PoseFrame, Projectile, Stance } from '../types';
import type { Intent } from '../intent/intents';

/**
 * Messages to/from the AWS signaling server (WebSocket). It only brokers the handshake.
 * `iceServers` carry short-lived TURN credentials, so use them instead of config.iceServers.
 */
export type SignalMessage =
  | { type: 'hello'; id: string } // server -> either, on connect
  | { type: 'host' } // host -> server: open a room
  | { type: 'room'; code: string; iceServers: RTCIceServer[] } // server -> host: room code to show on screen
  | { type: 'join'; code: string } // client -> server
  | { type: 'joined'; code: string; iceServers: RTCIceServer[] } // server -> client, before the offer
  | { type: 'peer-joined'; iceServers: RTCIceServer[] } // server -> host: create the connection and send the offer
  | { type: 'peer-left' } // server -> host: client left signaling (also sent once P2P is up), room is open again
  | { type: 'signal'; data: RTCSessionDescriptionInit | RTCIceCandidateInit } // relayed to the other peer
  | { type: 'error'; message: string }
  // Spectate: a screen watches a hosted room; the host casts its fight to it through the server.
  | { type: 'watch'; code: string } // spectator -> server
  | { type: 'watching'; code: string } // server -> spectator
  | { type: 'watchers'; count: number } // server -> host: how many screens watch its room
  | { type: 'cast'; data: HostMessage }; // host -> server -> every watching screen

/** Client -> host over the P2P data channels. */
export type ClientMessage =
  | { type: 'hello'; version: number }
  | { type: 'pose'; frame: PoseFrame } // "poses" channel: unordered, no retransmits
  | { type: 'profile'; name: string; consent: 'save' | 'masked'; username?: string } // after 'Scan new'; username: the forge saves the fighter under it
  | { type: 'pick'; fighterId: string } // after 'Choose existing'
  | { type: 'scan'; frames: [front: string, left: string, right: string] } // base64 JPEGs
  | { type: 'rematch' } // from the K.O. screen on the client laptop
  | { type: 'skip' } // "fight now": don't wait for P2's forge, use a stand-in until it's done
  | { type: 'leave' } // the player went back to the title (or closed the tab): free P2's slot for someone else
  // The client reads its own player's moves from its own full-rate camera (the network only carries the result):
  | { type: 'intents'; intents: Intent[]; stance: Stance } // reliable: every frame that produced intents
  | { type: 'stance'; stance: Stance }; // lossy: the continuous stance (guard, lean, tracked) on the other frames

/** Host -> client, so the client UI knows what to show its player. */
export type HostMessage =
  | { type: 'welcome'; player: PlayerId }
  | { type: 'roster'; fighters: ForgedFighter[] } // saved fighters for 'Choose existing'
  | { type: 'phase'; phase: Phase; countdown: number | null; winner?: PlayerId | null; ending?: 'ko' | 'time' | null }
  // The fight itself, so the client laptop shows it too (see Game's mirror):
  | { type: 'match'; players: Record<PlayerId, MatchPlayer> } // who's fighting as what; on connect and whenever it changes
  | { type: 'frame'; frame: MirrorFrame } // every sim tick while a fight is on ("poses" channel: lossy)
  | { type: 'events'; events: MirrorEvent[] } // hits, blocks, wind-ups, moves read: the moments that need effects
  | { type: 'fighter'; fighter: ForgedFighter; detail?: string; preview?: ForgePreview }; // P2's forge progress (detail: the host's status text, preview: the live forge preview); sent with status 'ready' once P2's fighter is set (scan, masked or pick)

export type MatchPlayer = { name: string; fighter: ForgedFighter | null; hp: number };

/** One tick of the host's fight, everything the director needs to draw it. */
export type MirrorFrame = {
  states: Record<PlayerId, FighterState>;
  guard: Record<PlayerId, boolean>;
  distance: number;
  /** In hit-stop: hold the picture. */
  frozen: boolean;
  timeLeft: number | null;
  projectiles?: Projectile[];
};

export type MirrorEvent =
  | { kind: 'fight'; event: FightEvent; by: FighterState; ko: boolean } // `by`: the attacker's state at the time
  | { kind: 'anticipate'; player: PlayerId; hand: Hand; cancel?: boolean } // cancel: it wasn't a strike after all
  | { kind: 'move'; player: PlayerId; text: string } // what the camera read, for that player's picture-in-picture
  | { kind: 'call'; lines: { voice: 'A' | 'B'; text: string }[]; urgent?: boolean }; // the commentators

/**
 * Wire envelope, not a game message: Peer splits control messages bigger than one
 * data-channel message (scan JPEGs) into these and reassembles them on the other side.
 */
export type ChunkMessage = { type: 'chunk'; id: number; index: number; count: number; data: string };

export const PROTOCOL_VERSION = 1;
