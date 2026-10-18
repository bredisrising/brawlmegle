// A contact sheet for a rig check, for humans: the fighter in a few of the game's poses, front and side, each vertex
// colored by the bone that owns it (blue = left arm, red = right arm, green = left leg, orange = right leg, gold = head,
// grey = torso), with the posed skeleton drawn on top. A software z-buffer in Node (no browser, no GPU), written as
// PNG with sharp. Used by `node forge/rigcheck.js fighter.glb --sheet out.png` and forge/rigcheck-all.js --sheets.

const CELL_W = 240;
const CELL_H = 300;
const LABEL = 22;
const VIEW_M = 1.3; // meters of fighter space shown top to bottom
const COLUMNS = ["rest", "cross", "hook", "knee", "victory", "ko"];

/** Owner colors by bone (RGB 0-1). */
function colorOf(bone) {
  if (!bone) return [0.95, 0.1, 0.9]; // weighted to something that isn't a Mixamo bone
  if (bone === "Head" || bone === "Neck") return [0.95, 0.78, 0.3];
  const shade = /Hand|Foot|ToeBase/.test(bone) ? 1 : /ForeArm|^.*[^p]Leg$/.test(bone) ? 0.75 : /Shoulder/.test(bone) ? 0.4 : 0.55;
  const mix = (c) => c.map((x) => x * (0.45 + 0.55 * shade) + 0.08);
  if (/^LeftArm|^LeftForeArm|^LeftHand|^LeftShoulder/.test(bone)) return mix([0.2, 0.45, 1]);
  if (/^RightArm|^RightForeArm|^RightHand|^RightShoulder/.test(bone)) return mix([1, 0.25, 0.25]);
  if (/^Left/.test(bone)) return mix([0.25, 0.85, 0.35]);
  if (/^Right/.test(bone)) return mix([1, 0.6, 0.15]);
  return [0.62, 0.62, 0.66];
}

/** Front: from +z (the opponent's side), screen right = +x. Side: from +x (the fighter's left), screen right = -z. */
const VIEWS = {
  front: (p) => [p[0], p[1], p[2]],
  side: (p) => [-p[2], p[1], p[0]],
};

function render(rgb, depth, W, ox, oy, vertices, indices, colors, view) {
  const k = CELL_H / VIEW_M;
  const cx = ox + CELL_W / 2;
  const base = oy + CELL_H - 12;
  const n = vertices.length / 3;
  const sx = new Float64Array(n), sy = new Float64Array(n), sz = new Float64Array(n);
  for (let v = 0; v < n; v++) {
    const [x, y, z] = view([vertices[v * 3], vertices[v * 3 + 1], vertices[v * 3 + 2]]);
    sx[v] = cx + x * k;
    sy[v] = base - y * k;
    sz[v] = z;
  }
  const project = (p) => {
    const [x, y, z] = view(p);
    return [cx + x * k, base - y * k, z];
  };
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = indices[t], b = indices[t + 1], c = indices[t + 2];
    // Face normal in view space for a little light (two-sided).
    const [ax, ay, az] = view([vertices[a * 3], vertices[a * 3 + 1], vertices[a * 3 + 2]]);
    const [bx, by, bz] = view([vertices[b * 3], vertices[b * 3 + 1], vertices[b * 3 + 2]]);
    const [qx, qy, qz] = view([vertices[c * 3], vertices[c * 3 + 1], vertices[c * 3 + 2]]);
    const ux = bx - ax, uy = by - ay, uz = bz - az, wx = qx - ax, wy = qy - ay, wz = qz - az;
    let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    const light = 0.35 + 0.65 * Math.abs(nz * 0.8 + ny * 0.45 + nx * 0.2);
    const minX = Math.max(ox, Math.floor(Math.min(sx[a], sx[b], sx[c])));
    const maxX = Math.min(ox + CELL_W - 1, Math.ceil(Math.max(sx[a], sx[b], sx[c])));
    const minY = Math.max(oy, Math.floor(Math.min(sy[a], sy[b], sy[c])));
    const maxY = Math.min(oy + CELL_H - 1, Math.ceil(Math.max(sy[a], sy[b], sy[c])));
    const area = (sx[b] - sx[a]) * (sy[c] - sy[a]) - (sx[c] - sx[a]) * (sy[b] - sy[a]);
    if (Math.abs(area) < 1e-9) continue;
    for (let py = minY; py <= maxY; py++) {
      for (let px = minX; px <= maxX; px++) {
        const x = px + 0.5, y = py + 0.5;
        const w0 = ((sx[b] - x) * (sy[c] - y) - (sx[c] - x) * (sy[b] - y)) / area;
        const w1 = ((sx[c] - x) * (sy[a] - y) - (sx[a] - x) * (sy[c] - y)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const z = w0 * sz[a] + w1 * sz[b] + w2 * sz[c];
        const i = py * W + px;
        if (z <= depth[i]) continue;
        depth[i] = z;
        for (let ch = 0; ch < 3; ch++) {
          const col = w0 * colors[a * 3 + ch] + w1 * colors[b * 3 + ch] + w2 * colors[c * 3 + ch];
          rgb[i * 3 + ch] = Math.min(255, col * light * 255);
        }
      }
    }
  }
  return project;
}

/** A line on top of everything (the skeleton). */
function line(rgb, W, H, [x0, y0], [x1, y1], color) {
  const steps = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))) + 1;
  for (let s = 0; s <= steps; s++) {
    const x = Math.round(x0 + ((x1 - x0) * s) / steps);
    const y = Math.round(y0 + ((y1 - y0) * s) / steps);
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1]]) {
      const px = x + dx, py = y + dy;
      if (px < 0 || py < 0 || px >= W || py >= H) continue;
      rgb.set(color, (py * W + px) * 3);
    }
  }
}

const escape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/**
 * @param {Awaited<ReturnType<typeof import("./rigcheck.js").checkRig>>} report  from checkRig(glb, { keep: true })
 * @param {string} out  PNG path
 */
export async function contactSheet(report, out, title = "") {
  const sharp = (await import("sharp")).default;
  const d = report.debug;
  if (!d) {
    // Nothing to draw (unreadable, no skin, missing bones): a card with the verdict.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="120"><rect width="100%" height="100%" fill="#222"/><text x="12" y="30" font-family="sans-serif" font-size="18" fill="#f66">${escape(title)} FAIL</text>${report.problems.map((p, i) => `<text x="12" y="${58 + i * 22}" font-family="sans-serif" font-size="14" fill="#eee">${escape(p.message)}</text>`).join("")}</svg>`;
    await sharp(Buffer.from(svg)).png().toFile(out);
    return out;
  }
  const columns = COLUMNS.filter((c) => c === "rest" || d.posed[c]);
  const rows = Object.keys(VIEWS);
  const W = CELL_W * columns.length;
  const H = LABEL + CELL_H * rows.length + 44;
  const rgb = new Uint8Array(W * H * 3).fill(34);
  const depth = new Float64Array(W * H).fill(-Infinity);
  const n = d.rest.vertices.length / 3;
  const colors = new Float64Array(n * 3);
  for (let v = 0; v < n; v++) colors.set(colorOf(d.boneOf.get(d.dominant[v])), v * 3);
  const parent = d.parents;
  const bones = Object.keys(parent).filter((b) => parent[b]);
  columns.forEach((col, ci) => {
    const shape = col === "rest" ? d.rest : d.posed[col];
    rows.forEach((row, ri) => {
      const ox = ci * CELL_W;
      const oy = LABEL + ri * CELL_H;
      const project = render(rgb, depth, W, ox, oy, shape.vertices, d.indices, colors, VIEWS[row]);
      for (const b of bones) line(rgb, W, H, project(shape.joints[parent[b]]), project(shape.joints[b]), [255, 255, 255]);
    });
  });
  const verdict = `${report.ok ? "OK" : "FAIL"} ${report.score}`;
  const problems = report.problems.filter((p) => p.level === "fail").map((p) => p.message).join(" · ") || "no problems";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    ${columns.map((c, i) => `<text x="${i * CELL_W + 8}" y="16" font-family="sans-serif" font-size="14" fill="#ddd">${c}</text>`).join("")}
    <text x="8" y="${H - 26}" font-family="sans-serif" font-size="14" fill="${report.ok ? "#6f6" : "#f66"}">${escape(title)}  ${verdict}</text>
    <text x="8" y="${H - 8}" font-family="sans-serif" font-size="12" fill="#ccc">${escape(problems.slice(0, 220))}</text>
  </svg>`;
  await sharp(Buffer.from(rgb), { raw: { width: W, height: H, channels: 3 } })
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toFile(out);
  return out;
}
