# Matchmaker

Pairs two players and passes their WebRTC connection details back and forth until they connect directly. After that, game traffic goes peer to peer and never touches this server. When a direct connection fails (strict school, office or event Wi-Fi), coturn on the same box relays it.

Separate from the game app: its own `package.json`, plain Node, one dependency (`ws`).

## Run it locally

```
cd matchmaker
npm install
npm start          # ws://127.0.0.1:3000/ws, test page at http://127.0.0.1:3000/
npm test           # starts a server and checks pairing, relaying, rooms, TURN credentials
```

The test page at `/` connects two browsers. Open it in two tabs (or two machines), use the same room code or none, and it shows whether the connection went direct or through TURN, plus the round-trip time. `?room=abc&relay=1&auto=1` joins automatically and forces TURN.

## Protocol

JSON messages over a WebSocket at `/ws`. Two ways to pair up: host and join by code (what the game uses), or random strangers and named rooms (the test page).

### Host and join by code

| Message | Direction | Means |
|---|---|---|
| `{type: "host", code?, token?}` | host → server | Open a room. After the host's socket drops (or the server restarts), send the old `code` and `token` to get the same code back, so the client's rejoin still finds it. |
| `{type: "room", code, token, iceServers}` | server → host | 4-character code to show on screen, plus the token that reclaims it. The room stays open while the host is connected, so a dropped client can rejoin. |
| `{type: "join", code}` | client → server | Join that room (case doesn't matter) |
| `{type: "joined", code, iceServers}` | server → client | In. Call `pc.setConfiguration({iceServers})` now; the offer comes after this. |
| `{type: "peer-joined", iceServers}` | server → host | Create the connection with these `iceServers` and send the offer |
| `{type: "signal", data}` | both ways | Offer, answer or ICE candidate, passed to the other side |
| `{type: "peer-left"}` | server → host | The client dropped; the room is open again |
| `{type: "error", message}` | server → either | No room with that code, room full, bad message |

`iceServers` includes short-lived TURN credentials, so don't hard-code TURN usernames or passwords in the app.

### Find a fight (the game's matchmaking)

Built on host and join by code: a quick player either joins someone who's waiting, or waits as a host itself.

| Message | Direction | Means |
|---|---|---|
| `{type: "quick", player}` | either → server | Find me an opponent. `player` is the player's id (one per browser tab, letters, digits, `-`, `_`), so the next match can prefer someone new. |
| `{type: "room", code, token, iceServers}` | server → player | Nobody (new) is waiting: you wait as a host. Same as the reply to `host`; the game doesn't show this code. The usual `peer-joined` follows when someone is sent to you. |
| `{type: "quick-join", code}` | server → player | Join this waiting host: send `{type: "join", code, player}` (the game opens a fresh socket for it). The host is held for your `player` for 10 s; a join by anyone else is refused meanwhile. A waiting host can get this too (the sweep below), and then its own room is closed. |

- The oldest waiting quick host that isn't your last opponent gets you.
- Two players who just fought each other and search again both wait; if nobody new turns up in 3 s (`QUICK_REPAIR_MS`), the newer one is sent to the older one. So two people online keep getting paired.
- A sweep every 0.5 s also pairs any two quick hosts waiting at once (e.g. the player matched with one of them never joined and its hold ran out).
- A quick host is out of the queue once someone joins it, or when it leaves or disconnects. To search again, send `quick` again (the game opens a fresh socket).
- `/health` counts waiting quick hosts as `quick`.

### Random strangers and named rooms

Client → server:

| Message | Does |
|---|---|
| `{type: "join"}` | Wait for a random stranger |
| `{type: "join", room: "abc"}` | Wait in a private room (letters, digits, `-`, `_`, up to 32). The second person in gets matched. |
| `{type: "signal", data}` | Pass `data` (offer, answer or ICE candidate) to your matched peer |
| `{type: "next"}` | Drop your peer and wait for a new random stranger |
| `{type: "leave"}` | Drop your peer or stop waiting |

Server → client:

| Message | Means |
|---|---|
| `{type: "hello", id}` | Connected |
| `{type: "waiting", room?}` | In the queue or room |
| `{type: "matched", peer, initiator, iceServers}` | Paired. The `initiator` creates the offer. Pass `iceServers` straight to `new RTCPeerConnection({iceServers})`; it includes short-lived TURN credentials. |
| `{type: "signal", data}` | From your peer |
| `{type: "peer-left"}` | Your peer left or pressed next |
| `{type: "error", error, message}` | Bad message |

The test page's script is a working client to copy from. Two things to keep: process incoming messages one at a time (so ICE candidates don't arrive before the offer is applied), and use an unordered data channel with `maxRetransmits: 0` for game inputs.

## Deployed server

- Matchmaker: `wss://54-149-60-196.sslip.io/ws`. Test page: https://54-149-60-196.sslip.io/
- TURN: `turn.54-149-60-196.sslip.io` (the matchmaker hands out the URLs and credentials, so the game never hard-codes them)
- `sslip.io` is a free DNS service that turns a name like `54-149-60-196.sslip.io` into that IP, so we don't need a domain yet.
- Tested from the DubHacks Wi-Fi: it blocks port 3478, but relaying over 443 works (about 32 ms round trip). From a home network, 3478 works too.

- One `t4g.micro` EC2 instance in us-west-2 named `brawlegle-matchmaker`, tagged `Project=brawlegle`, with a fixed (Elastic) IP.
- nginx takes port 443 and routes by hostname: the matchmaker hostname goes to the Node app, and the TURN hostname goes to coturn (TURN over TLS). Both work on networks that only allow HTTPS.
- coturn also listens on 3478 (UDP and TCP), with relay ports 49152–49999/UDP.
- The TURN secret is generated on the server and never leaves it. Bandwidth through TURN is capped at about 10 Mbps total.

### Update the code or switch domains

`deploy/setup.sh` is safe to re-run. Copy this folder to the server and run:

```
sudo DOMAIN=match.example.com TURN_DOMAIN=turn.example.com deploy/setup.sh
```

To move to a real domain, add two DNS A records pointing at the server's Elastic IP (one for each hostname), then re-run the script with the new names. It requests a new certificate automatically.
