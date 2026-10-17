import type { ForgedFighter, Phase, PlayerId, PoseFrame } from '../types';

/** Messages to/from the AWS signaling server (WebSocket). It only brokers the handshake. */
export type SignalMessage =
  | { type: 'host' } // host -> server: open a room
  | { type: 'room'; code: string } // server -> host: room code to show on screen
  | { type: 'join'; code: string } // client -> server
  | { type: 'peer-joined' } // server -> host
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
  | { type: 'fighter'; fighter: ForgedFighter };

export const PROTOCOL_VERSION = 1;
