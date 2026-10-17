import type { ClientMessage, HostMessage } from './protocol';
import type { Signaling } from './Signaling';
import type { Role } from '../types';

/**
 * WebRTC connection between host and client laptops.
 * Two data channels: "poses" (unordered, maxRetransmits 0) and "control" (reliable).
 *
 * TODO:
 *  - host(): ask signaling for a room, wait for peer-joined, create offer
 *  - join(code): join room, answer the offer
 *  - relay ICE candidates through Signaling; STUN + TURN servers from config
 *  - send()/onMessage() over the right channel by message type
 */
export class Peer {
  readonly role: Role;
  private readonly signaling: Signaling;

  constructor(role: Role, signaling: Signaling) {
    this.role = role;
    this.signaling = signaling;
  }

  /** Host only: returns the room code to show on the title screen. */
  async host(): Promise<string> {
    void this.signaling;
    return '';
  }

  /** Client only. */
  async join(_code: string): Promise<void> {}

  send(_msg: ClientMessage | HostMessage): void {}

  onMessage(_cb: (msg: ClientMessage | HostMessage) => void): () => void {
    return () => {};
  }

  close(): void {}
}
