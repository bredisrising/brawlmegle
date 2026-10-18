import { config } from '../../src/config';
import { Game } from '../../src/game/Game';
import { useGameStore } from '../../src/game/store';
import { RemoteSource } from '../../src/input';
import { Peer } from '../../src/net/Peer';
import { Signaling } from '../../src/net/Signaling';
import { PROTOCOL_VERSION, type ClientMessage, type HostMessage, type SignalMessage } from '../../src/net/protocol';
import type { PoseFrame } from '../../src/types';
import { poll, TestHost } from './TestHost';

/**
 * Runs in a real browser (see test/p2p.mjs): connects the game's client Peer through the matchmaker
 * to a test host, then to the game's host Peer, then to a real Game hosting, and checks what crosses
 * the data channels. Results go on window.__p2p.
 */
type Result = { name: string; ok: boolean; error?: string; ms: number };
declare global {
  interface Window {
    __p2p?: { done: boolean; results: Result[] };
  }
}

const signalUrl = new URLSearchParams(location.search).get('signal') ?? '';
// The Game reads these: point it at the test matchmaker, and mock the forge (no network, no credits).
config.signalUrl = signalUrl;
config.forgeApi = '';
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

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The game's own host Peer (Peer.host) with a RemoteSource, against the game's client Peer. */
async function runHostPeer() {
  const host = new Peer('host', new Signaling(signalUrl));
  const remote = new RemoteSource(host);
  await remote.start();
  const frames: PoseFrame[] = [];
  remote.onFrame((f) => frames.push(f));
  const inbox: ClientMessage[] = [];
  host.onMessage((m) => m.type !== 'pose' && inbox.push(m as ClientMessage));
  let connects = 0;
  let drops = 0;
  host.onConnected(() => connects++);
  host.onClose(() => drops++);
  let code = '';

  await test('Peer.host() opens a room and returns its code', async () => {
    code = await host.host();
    assert(/^[A-Z2-9]{4}$/.test(code), `bad code ${code}`);
    assert(host.roomCode === code, 'roomCode not set');
  });

  const first = clientPeer();

  await test('host Peer: client joins, both sides connect, host uses the server iceServers', async () => {
    await first.peer.join(code);
    await poll(() => connects === 1 || undefined, 'host onConnected');
    assert(host.connected && first.peer.connected, 'not connected');
    const urls = pcOf(host)
      .getConfiguration()
      .iceServers?.flatMap((s) => s.urls);
    assert(
      urls?.some((u) => u.startsWith('turn:')),
      `no TURN server in the host's config: ${JSON.stringify(urls)}`,
    );
  });

  await test("host Peer: client poses reach the host's RemoteSource", async () => {
    for (let t = 0; t < 30; t++) first.peer.send({ type: 'pose', frame: frame(t) });
    await poll(() => frames.length > 0 || undefined, 'remote frames');
    assert(remote.latestFrame !== null, 'no latestFrame');
  });

  await test('host Peer: control messages both ways, chunked both ways', async () => {
    const jpeg = 'B'.repeat(60_000);
    first.peer.send({ type: 'scan', frames: [jpeg, jpeg, jpeg] });
    const scan = await poll(() => inbox.find((m) => m.type === 'scan'), 'scan on the host');
    assert(scan.type === 'scan' && scan.frames[2] === jpeg, 'scan arrived corrupted');
    const fighters = Array.from({ length: 300 }, (_, i) => ({ id: `f${i}`, name: `Fighter ${i}`, status: 'ready' as const }));
    host.send({ type: 'roster', fighters });
    const roster = await poll(() => first.inbox.find((m) => m.type === 'roster'), 'roster on the client');
    assert(roster.type === 'roster' && roster.fighters.length === 300, 'roster arrived incomplete');
  });

  await test('host Peer: stays connected after peer-left (client closed signaling)', async () => {
    await wait(500);
    assert(host.connected && drops === 0, `connected ${host.connected}, drops ${drops}`);
  });

  await test('host Peer: a third laptop joining the code does not kick P2', async () => {
    const third = clientPeer();
    const joining = third.peer.join(code).catch(() => {});
    await wait(800);
    third.peer.close();
    await joining;
    assert(host.connected && connects === 1 && drops === 0, `connected ${host.connected}, connects ${connects}, drops ${drops}`);
    first.peer.send({ type: 'hello', version: PROTOCOL_VERSION });
    await poll(() => inbox.find((m) => m.type === 'hello'), 'hello after the third laptop');
  });

  await test('host Peer: hears the client drop, then the client rejoins the same code', async () => {
    first.peer.close();
    await poll(() => drops === 1 || undefined, 'host onClose');
    assert(!host.connected, 'host still says connected');
    const second = clientPeer();
    await second.peer.join(code);
    await poll(() => connects === 2 || undefined, 'host onConnected after rejoin');
    const before = frames.length;
    for (let t = 0; t < 30; t++) second.peer.send({ type: 'pose', frame: frame(1000 + t) });
    await poll(() => frames.length > before || undefined, 'poses after rejoin');
    second.peer.close();
  });

  first.peer.close();
  remote.stop();
  host.close();
}

/** A real Game hosting: code in the store, client connects, P2 is set up from its pick, poses drive P2. */
async function runGameHost() {
  const container = document.createElement('div');
  container.style.cssText = 'width: 320px; height: 180px';
  document.body.append(container);
  let game: Game;
  try {
    game = new Game(container);
  } catch (err) {
    // No WebGL in this browser: the Renderer can't start, so neither can a Game.
    results.push({ name: 'game host: create a Game', ok: false, error: String(err), ms: 0 });
    return;
  }
  const g = game;
  let client = clientPeer();
  const fighterMsgs = () => client.inbox.filter((m) => m.type === 'fighter');
  const readyMsg = (name?: string) =>
    fighterMsgs().find((m) => m.type === 'fighter' && m.fighter.status === 'ready' && (!name || m.fighter.name === name));

  await test('game host: Host puts a room code in the store', async () => {
    await g.host();
    const { roomCode, role, screen } = useGameStore.getState();
    assert(roomCode && /^[A-Z2-9]{4}$/.test(roomCode), `bad room code ${roomCode}`);
    assert(role === 'host' && screen === 'avatar', `role ${role}, screen ${screen}`);
  });

  await test('game host: client joins, gets welcome + roster + lobby phase, store says open', async () => {
    await client.peer.join(useGameStore.getState().roomCode!);
    await poll(() => useGameStore.getState().connection === 'open' || undefined, 'connection open');
    const welcome = await poll(() => client.inbox.find((m) => m.type === 'welcome'), 'welcome');
    assert(welcome.type === 'welcome' && welcome.player === 'p2', 'wrong welcome');
    const phase = await poll(() => client.inbox.find((m) => m.type === 'phase'), 'phase');
    assert(phase.type === 'phase' && phase.phase === 'lobby', 'wrong phase');
    const roster = await poll(() => client.inbox.find((m) => m.type === 'roster'), 'roster');
    assert(roster.type === 'roster' && roster.fighters.some((f) => f.id === 'house-1'), 'no house fighters in the roster');
  });

  await test("game host: the client's profile + scan forge P2 (mock forge), with progress sent back", async () => {
    client.peer.send({ type: 'hello', version: PROTOCOL_VERSION });
    client.peer.send({ type: 'profile', name: 'ankit', consent: 'save', username: 'ankit' });
    await poll(() => (useGameStore.getState().players.p2.status === 'scanning' ? true : undefined), 'p2 scanning on the host');
    await wait(300);
    // The client shows its own scan progress; the host stays quiet until it has the frames.
    assert(fighterMsgs().length === 0, 'host sent fighter updates during the scan');
    client.peer.send({ type: 'scan', frames: ['data:image/jpeg;base64,AAAA', '', ''] });
    const forging = await poll(() => fighterMsgs().find((m) => m.type === 'fighter' && m.fighter.status === 'forging'), 'forging update');
    assert(forging.type === 'fighter' && forging.detail, 'forging update without status text');
    await poll(() => readyMsg('ankit'), 'scanned fighter ready', 20_000);
  });

  await test("game host: the client's pick sets up P2 and the client hears 'ready'", async () => {
    client.peer.send({ type: 'pick', fighterId: 'house-1' });
    const ready = await poll(() => readyMsg('Kid Haymaker'), 'fighter ready', 20_000);
    assert(ready.type === 'fighter' && ready.fighter.name === 'Kid Haymaker', 'wrong fighter name');
    const p2 = useGameStore.getState().players.p2;
    assert(p2.status === 'ready' && p2.name === 'Kid Haymaker', `host p2 is ${p2.status} ${p2.name}`);
  });

  await test("game host: client poses reach P2's input on the host", async () => {
    for (let t = 0; t < 30; t++) client.peer.send({ type: 'pose', frame: frame(5000 + t) });
    await poll(() => ((g.input.latest('p2')?.t ?? 0) >= 5000 ? true : undefined), "p2's frames on the host");
    assert(g.input.source('p2')?.kind === 'remote', `p2 source is ${g.input.source('p2')?.kind}`);
  });

  await test('game host: the client follows the phase (countdown once P1 is ready too)', async () => {
    await g.addTestPlayer('p1');
    await poll(() => client.inbox.find((m) => m.type === 'phase' && m.phase === 'countdown'), 'countdown phase');
  });

  await test('game host: drop shows reconnecting; a rejoin keeps P2 and takes a fresh pose clock', async () => {
    client.peer.close();
    await poll(() => useGameStore.getState().connection === 'reconnecting' || undefined, 'connection reconnecting');
    client = clientPeer();
    await client.peer.join(useGameStore.getState().roomCode!);
    await poll(() => useGameStore.getState().connection === 'open' || undefined, 'connection open again');
    // P2's fighter is kept: the rejoined client hears it's ready, and a resent pick doesn't start over.
    await poll(() => readyMsg('Kid Haymaker'), 'fighter ready after rejoin');
    client.peer.send({ type: 'pick', fighterId: 'house-1' });
    await poll(() => (fighterMsgs().length >= 2 ? true : undefined), 'resent pick answered');
    assert(useGameStore.getState().players.p2.status === 'ready', 'p2 was reset');
    // A reloaded client's pose clock starts over; the host must not drop those frames as stale.
    for (let t = 0; t < 30; t++) client.peer.send({ type: 'pose', frame: frame(t) });
    await poll(() => ((g.input.latest('p2')?.t ?? Infinity) < 100 ? true : undefined), 'restarted pose clock on the host');
  });

  client.peer.close();
  g.dispose();
}

run()
  .then(runHostPeer)
  .then(runGameHost)
  .catch((err) => results.push({ name: 'test run crashed', ok: false, error: String(err), ms: 0 }))
  .finally(() => (window.__p2p!.done = true));
