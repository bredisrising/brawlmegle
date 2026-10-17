import { Peer } from '../../src/net/Peer';
import { Signaling } from '../../src/net/Signaling';
import { PROTOCOL_VERSION, type ClientMessage, type HostMessage, type SignalMessage } from '../../src/net/protocol';
import type { PoseFrame } from '../../src/types';
import { poll, TestHost } from './TestHost';

/**
 * Runs in a real browser (see test/p2p.mjs): connects the game's client Peer to a test host through
 * the matchmaker and checks what crosses the data channels. Results go on window.__p2p.
 */
type Result = { name: string; ok: boolean; error?: string; ms: number };
declare global {
  interface Window {
    __p2p?: { done: boolean; results: Result[] };
  }
}

const signalUrl = new URLSearchParams(location.search).get('signal') ?? '';
const results: Result[] = [];
window.__p2p = { done: false, results };

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

async function test(name: string, fn: () => Promise<void>) {
  const start = performance.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Math.round(performance.now() - start) });
  } catch (err) {
    results.push({ name, ok: false, error: err instanceof Error ? err.message : String(err), ms: Math.round(performance.now() - start) });
  }
  console.log(`[p2p] ${results.at(-1)!.ok ? 'ok  ' : 'FAIL'} ${name}`);
}

function clientPeer() {
  const peer = new Peer('client', new Signaling(signalUrl));
  const inbox: HostMessage[] = [];
  peer.onMessage((msg) => inbox.push(msg as HostMessage));
  return { peer, inbox };
}

/** Peer keeps its RTCPeerConnection private; the test peeks at it to check the ICE config. */
const pcOf = (peer: Peer) => (peer as unknown as { pc: RTCPeerConnection }).pc;

const isType =
  <K extends SignalMessage['type']>(type: K) =>
  (m: SignalMessage): m is Extract<SignalMessage, { type: K }> =>
    m.type === type;

const landmarks = Array.from({ length: 33 }, (_, i) => ({ x: i / 33, y: 0.5, z: 0, visibility: 1 }));
const frame = (t: number) => ({ t, image: landmarks, world: landmarks }) as unknown as PoseFrame;

async function run() {
  const host = new TestHost(signalUrl);
  let code = '';

  await test('join with an unknown code rejects with the server error', async () => {
    const { peer } = clientPeer();
    const err = await peer.join('ZZZZ').then(
      () => null,
      (e: Error) => e,
    );
    peer.close();
    assert(err, 'join() resolved');
    assert(/No room with code/.test(err.message), `unexpected error: ${err.message}`);
  });

  await test('host opens a room and gets a 4-character code', async () => {
    code = await host.open();
    assert(/^[A-Z2-9]{4}$/.test(code), `bad code ${code}`);
  });

  const first = clientPeer();

  await test('client joins by code and both data channels open', async () => {
    await first.peer.join(code.toLowerCase());
    await host.whenOpen();
    assert(first.peer.connected, 'client says not connected');
  });

  await test("client uses the iceServers from the server's joined message", async () => {
    const urls = pcOf(first.peer)
      .getConfiguration()
      .iceServers?.flatMap((s) => s.urls);
    assert(
      urls?.some((u) => u.startsWith('turn:')),
      `no TURN server in the client's config: ${JSON.stringify(urls)}`,
    );
  });

  await test('host gets peer-left once the client closes signaling (room reopens)', async () => {
    await host.waitFor(isType('peer-left'));
  });

  await test('control messages go both ways', async () => {
    first.peer.send({ type: 'hello', version: PROTOCOL_VERSION });
    const hello = await host.waitForMessage('hello');
    assert(hello.version === PROTOCOL_VERSION, 'wrong version');
    host.send({ type: 'welcome', player: 'p2' } satisfies HostMessage);
    const welcome = await poll(() => first.inbox.find((m) => m.type === 'welcome'), 'welcome');
    assert(welcome.type === 'welcome' && welcome.player === 'p2', 'wrong welcome');
  });

  await test('large client message is chunked and reassembled (scan JPEGs)', async () => {
    const jpeg = 'A'.repeat(80_000);
    const scan: ClientMessage = { type: 'scan', frames: [jpeg + 'f', jpeg + 'l', jpeg + 'r'] };
    first.peer.send(scan);
    const got = await host.waitForMessage('scan');
    assert(JSON.stringify(got) === JSON.stringify(scan), 'scan arrived corrupted');
  });

  await test('client reassembles a chunked host message', async () => {
    const fighters = Array.from({ length: 200 }, (_, i) => ({ id: `f${i}`, name: `Fighter ${i}`, status: 'ready' as const }));
    host.send({ type: 'roster', fighters } satisfies HostMessage, 4096);
    const roster = await poll(() => first.inbox.find((m) => m.type === 'roster'), 'roster');
    assert(roster.type === 'roster' && roster.fighters.length === 200, 'roster arrived incomplete');
  });

  await test('poses arrive on the lossy channel', async () => {
    for (let t = 0; t < 30; t++) first.peer.send({ type: 'pose', frame: frame(t) });
    await poll(() => host.posesReceived.length > 0 || undefined, 'poses');
    assert(!host.received.some((m) => m.type === 'pose'), 'poses went over the control channel');
  });

  await test('client hears about a dropped link via onClose', async () => {
    const closed = new Promise<void>((resolve) => first.peer.onClose(resolve));
    host.dropPeer();
    await Promise.race([closed, poll(() => undefined, 'onClose', 8000)]);
  });

  await test('a new client can rejoin the same room after a drop', async () => {
    const from = host.signals.length;
    const second = clientPeer();
    await second.peer.join(code);
    await host.waitFor(isType('peer-joined'), from);
    await host.whenOpen();
    second.peer.send({ type: 'hello', version: PROTOCOL_VERSION });
    await poll(() => host.received.filter((m) => m.type === 'hello').length >= 2 || undefined, 'second hello');
    second.peer.close();
  });

  first.peer.close();
  host.close();
}

run().finally(() => (window.__p2p!.done = true));
