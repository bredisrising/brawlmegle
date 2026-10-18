// The page clock at K (see capture.mjs): performance.now, Date.now, rAF, timers, video frame callbacks, audio clock.
export /** Runs in the page before anything else: the clock runs at K. */
function warpClock(K) {
  if (K === 1) return;
  const perf = performance.now.bind(performance);
  const R0 = perf();
  const warp = (t) => R0 + (t - R0) * K;
  performance.now = () => warp(perf());
  const dateNow = Date.now;
  const W0 = dateNow();
  Date.now = () => Math.round(W0 + (dateNow() - W0) * K);
  window.__warp = { K, W0, R0 };
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => raf((t) => cb(warp(t)));
  const st = window.setTimeout.bind(window);
  const si = window.setInterval.bind(window);
  window.setTimeout = (fn, d = 0, ...a) => st(fn, (Number(d) || 0) / K, ...a);
  window.setInterval = (fn, d = 0, ...a) => si(fn, (Number(d) || 0) / K, ...a);
  const rvfc = HTMLVideoElement.prototype.requestVideoFrameCallback;
  if (rvfc) {
    window.__cam = [];
    HTMLVideoElement.prototype.requestVideoFrameCallback = function (cb) {
      return rvfc.call(this, (now, meta) => {
        const m = { ...meta, expectedDisplayTime: warp(meta.expectedDisplayTime) };
        if (meta.captureTime !== undefined) m.captureTime = warp(meta.captureTime);
        if (this.srcObject && window.__cam.length < 200000) window.__cam.push([Math.round(warp(now)), meta.presentedFrames]);
        cb(warp(now), m);
      });
    };
  }
  const desc = Object.getOwnPropertyDescriptor(BaseAudioContext.prototype, "currentTime");
  Object.defineProperty(BaseAudioContext.prototype, "currentTime", {
    configurable: true,
    get() {
      const t = desc.get.call(this);
      if (this.__c0 === undefined) this.__c0 = t;
      return this.__c0 + (t - this.__c0) * K;
    },
  });
  // Media (the highlight reel) plays at K too.
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...a) {
    if (!this.srcObject) {
      this.playbackRate = K;
      this.defaultPlaybackRate = K;
    }
    return play.apply(this, a);
  };
}

