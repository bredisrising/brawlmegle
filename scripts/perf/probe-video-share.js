// Probe for run.mjs (--probe): the opponent-camera share's cost, without a second laptop. A loopback WebRTC pair sends
// this laptop's camera both ways the way CameraShare + Peer do (a copy shrunk to <=320x240 at <=15 fps, VP8 capped at
// 250 kbps) and shows the received one in a small video element. That's two encodes and two decodes, more than one
// laptop does in a real match (one of each), so it overstates the cost. Returns the encoder's stats after 4 s.
(async () => {
  const src = window.__brawl.game.localInputSource();
  const stream = src?.video?.srcObject;
  if (!stream) return { error: "no camera stream (run with input=camera)" };
  const light = () => {
    const t = stream.getVideoTracks()[0].clone();
    return t.applyConstraints({ width: { max: 320 }, height: { max: 240 }, frameRate: { max: 15 }, resizeMode: "crop-and-scale" }).then(() => t);
  };
  const enc = [{ maxBitrate: 250_000, maxFramerate: 15 }];
  const a = new RTCPeerConnection();
  const b = new RTCPeerConnection();
  a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
  b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
  a.addTransceiver(await light(), { direction: "sendrecv", sendEncodings: enc });
  const received = new Promise((r) => (b.ontrack = (e) => r(e.track)));
  await a.setLocalDescription();
  await b.setRemoteDescription(a.localDescription);
  const bt = b.getTransceivers()[0];
  bt.direction = "sendrecv";
  await bt.sender.replaceTrack(await light());
  await b.setLocalDescription();
  await a.setRemoteDescription(b.localDescription);
  const v = document.createElement("video");
  v.muted = true;
  v.autoplay = true;
  v.srcObject = new MediaStream([await received]);
  v.style.cssText = "position:fixed;right:16px;bottom:88px;width:220px;z-index:50";
  document.body.append(v);
  await v.play().catch(() => {});
  window.__videoShare = { a, b, v };
  await new Promise((r) => setTimeout(r, 4000));
  const out = {};
  (await a.getStats()).forEach((r) => {
    if (r.type === "outbound-rtp" && r.kind === "video") Object.assign(out, { width: r.frameWidth, height: r.frameHeight, fps: r.framesPerSecond, encoder: r.encoderImplementation, kbps: Math.round((r.bytesSent * 8) / 1000 / 4) });
  });
  (await b.getStats()).forEach((r) => {
    if (r.type === "inbound-rtp" && r.kind === "video") Object.assign(out, { decoded: r.framesDecoded, decoder: r.decoderImplementation });
  });
  out.shown = `${v.videoWidth}x${v.videoHeight}`;
  return out;
})()
