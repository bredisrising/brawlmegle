import type { ForgedFighter, Phase, PlayerId, PoseFrame } from '../types';

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
  | { type: 'error'; message: string };

/** Client -> host over the P2P data channels. */
export type ClientMessage =
  | { type: 'hello'; version: number }
  | { type: 'pose'; frame: PoseFrame } // "poses" channel: unordered, no retransmits
  | { type: 'profile'; name: string; consent: 'save' | 'masked' } // after 'Scan new'
  | { type: 'pick'; fighterId: string } // after 'Choose existing'
  | { type: 'scan'; frames: [front: string, left: string, right: string] }; // base64 JPEGs

/** Host -> client, so the client UI knows what to show its player. */
export type HostMessage =
  | { type: 'welcome'; player: PlayerId }
  | { type: 'roster'; fighters: ForgedFighter[] } // saved fighters for 'Choose existing'
  | { type: 'phase'; phase: Phase; countdown: number | null }
  | { type: 'fighter'; fighter: ForgedFighter }; // P2's forge progress; sent with status 'ready' once P2's fighter is set (scan, masked or pick)

/**
 * Wire envelope, not a game message: Peer splits control messages bigger than one
 * data-channel message (scan JPEGs) into these and reassembles them on the other side.
 */
export type ChunkMessage = { type: 'chunk'; id: number; index: number; count: number; data: string };

export const PROTOCOL_VERSION = 1;
