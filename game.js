// Stretch Miner — "gold miner" played by stretching
// The camera feed is shown live, centred along the bottom edge of the canvas (mirrored, like a mirror)
// Three controls: head (shift body/head left-right, no hands) · arm (reach a real arm) · mouse (fallback)
// Everything is processed locally: nothing is uploaded, nothing is stored.

// The library and model are loaded from the local copy in this repo first (same origin, so whoever
// opens the page never needs to reach jsdelivr / Google);
// the online source is only a fallback. Library and wasm must come from the same source — never mix versions.
// Every source lists "the 4 files to download" so the progress bar has a real denominator.
const CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
const GCS = "https://storage.googleapis.com/mediapipe-models/pose_landmarker";
const SOURCES = [
  {
    name: "Local",
    lib: "./vendor/vision_bundle.mjs",
    wasm: "./vendor/wasm",
    models: ["./vendor/models/pose_landmarker_lite.task"],
  },
  {
    name: "Online",
    lib: `${CDN}/vision_bundle.mjs`,
    wasm: `${CDN}/wasm`,
    models: [
      `${GCS}/pose_landmarker_lite/float16/1/pose_landmarker_lite.task`,
      `${GCS}/pose_landmarker_full/float16/1/pose_landmarker_full.task`,
    ],
  },
];
// Nominal size of each file in bytes — used to compute the percentage; a real content-length wins when present
const SIZE = {
  lib: 137 * 1024,
  loader: 210 * 1024,
  wasm: 9423986,
  modelLite: 5777746,
  modelFull: 29 * 1024 * 1024,
};
const KB = 1024, MB = 1024 * 1024;
const fmtBytes = (b) =>
  b >= MB ? `${(b / MB).toFixed(1)} MB` : `${Math.max(1, Math.round(b / KB))} KB`;

const canvas = document.getElementById("stage");
const ctx = canvas.getContext("2d");
const W = canvas.width;
const H = canvas.height;
const video = document.getElementById("cam");

// The whole UI is drawn inside the canvas — no text or button lives below it.
// One invisible live region is kept for screen readers.
const el = {
  status: document.getElementById("a11y"),
};

// Camera panel: centred along the bottom of the canvas — this frame is Granny's face
const PANEL = { w: 300, h: 225, x: W / 2 - 150, y: H - 225 - 14 };
// The arm reaches out from the middle of this panel's top edge
const ANCHOR = { x: W / 2, y: PANEL.y };
const STRETCH_SPEED = 430;   // stretch speed px/s
const RETRACT_SPEED = 1500;  // retract speed px/s ("snap back")
const MAX_REACH = 780;
const TIP_R = 14;
const MIN_TILT = 0.10;       // tilt just past the threshold (~6°, almost straight up)
const MAX_TILT = 1.15;       // tilt at full lean (~66°)

// ---------- Look: marker-pen strokes + high-saturation palette ----------
const INK = "#2B1533";
const C = {
  teal: "#00B8A9", magenta: "#FF3D7F", orange: "#FF8A3D", yellow: "#FFD23F",
  purple: "#8A4FFF", red: "#E5322D", blue: "#1E7BE8", green: "#4FD14F",
  pink: "#FF9BC6", cream: "#FFF4DC", wood: "#E08A2B", woodDark: "#B45F1C",
  gold: "#F2B705", lilac: "#CDB4FF", skin: "#F6C9A0", skinShade: "#E0A277",
};

// Every stroke goes through pen (the main canvas by default); painting the static desk switches it to an offscreen canvas
let pen = ctx;

// Deterministic jitter: one object wobbles identically on every frame, so the picture never flickers
function _h(n) { const s = Math.sin(n * 12.9898) * 43758.5453; return s - Math.floor(s); }
function jit(pts, seed, amt) {
  return pts.map((p, i) => ({
    x: p.x + (_h(seed + i * 1.31) - 0.5) * amt,
    y: p.y + (_h(seed + i * 2.17 + 5) - 0.5) * amt,
  }));
}
function trace(pts, close) {
  pen.beginPath();
  pen.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) pen.lineTo(pts[i].x, pts[i].y);
  if (close) pen.closePath();
}
// One fill pass + two stroke passes: colour deliberately spills past the outline, like colouring outside the lines
function ink(pts, o = {}) {
  const { fill = null, stroke = INK, lw = 3, close = true, seed = 1, amt = 2.6, passes = 2, jf = 0.7 } = o;
  if (fill) {
    trace(jit(pts, seed + 40, amt * jf), close);
    pen.fillStyle = fill;
    pen.fill();
  }
  if (stroke) {
    pen.strokeStyle = stroke;
    pen.lineWidth = lw;
    pen.lineJoin = "round";
    pen.lineCap = "round";
    for (let i = 0; i < passes; i++) {
      trace(jit(pts, seed + i * 9.3, amt), close);
      pen.stroke();
    }
  }
}
function ringPts(cx, cy, r, n = 14, squash = 1) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r * squash });
  }
  return out;
}
function disc(cx, cy, r, o = {}) { ink(ringPts(cx, cy, r, o.n || 14, o.squash || 1), o); }
function rectPts(x, y, w, h) { return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }]; }
function bar(x1, y1, x2, y2, color = INK, lw = 4, seed = 1, amt = 1.8) {
  ink([{ x: x1, y: y1 }, { x: x2, y: y2 }], { stroke: color, lw, close: false, seed, amt, passes: 2 });
}
function roughArc(cx, cy, r, a0, a1, o = {}) {
  const n = o.n || 10;
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (a1 - a0) * (i / n);
    pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r * (o.squash || 1) });
  }
  ink(pts, { ...o, close: false });
}

// ---------- Things on the desk ----------
// What Granny is looking for: glasses, necklace, earring, ring, brooch, hairpin
const KIND = {
  glasses: { r: 21, label: "glasses" },
  necklace: { r: 22, label: "necklace" },
  earring: { r: 17, label: "earring" },
  ring: { r: 16, label: "ring" },
  brooch: { r: 18, label: "brooch" },
  hairpin: { r: 19, label: "hairpin" },
};
// Must not be touched: bugs, and bare plugs that are still live
const HAZARD = {
  bug: { r: 19, label: "bug" },
  plug: { r: 20, label: "plug" },
};
const isHazard = (k) => k === "bug" || k === "plug";

const TREASURE_PLAN = ["glasses", "necklace", "earring", "ring", "brooch", "hairpin", "glasses"];
const HAZARD_PLAN = ["bug", "plug", "bug"];

// Sensitivity: 0 = least responsive, 1 = most responsive (live slider, no code edit needed)
let sens = 0.5;
function thresholds() {
  return {
    leanStart: 0.20 - 0.16 * sens,           // 0.20 → 0.04
    leanKeep: (0.20 - 0.16 * sens) * 0.55,
    needUp: 0.34 - 0.20 * sens,              // 0.34 → 0.14
    needLen: 0.60 - 0.24 * sens,             // 0.60 → 0.36
  };
}

const game = {
  phase: "home",         // home | loading (downloading) | playing | over
  input: "none",         // head | arm | mouse
  score: 0,
  lives: 3,
  items: [],
  arm: { len: 0, dir: { x: 0, y: -1 }, mode: "idle", carry: null, lock: false },
  pops: [],          // short lines that pop up on screen ("Found it!" / "Yuck, a bug!")
  flash: 0,
  flashColor: "226,75,74",
  shake: 0,
  lastTs: 0,
  seenPerson: false,
  debug: "",
  lean: 0,          // current lean (positive = toward the right of frame)
  centerX: 0.5,     // the calibrated "centre" position
  trackX: 0.5,      // horizontal body position measured right now
  armInfo: "",
  status: "",       // the status line drawn inside the canvas (no longer shown as DOM)
};

// ---------- UI system inside the canvas ----------
// Every button is a rectangle on the canvas: registered while drawing, hit-tested on click.
const ui = {
  hits: [],                       // buttons registered this frame {x,y,w,h,action}
  click: null,                    // pending click (canvas coords)
  hover: { x: -999, y: -999, on: false },
  drag: null,                     // slider currently being dragged
};
const inRect = (p, x, y, w, h) => p && p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h;

// ---------- Download progress ----------
const loader = {
  on: false,
  done: 0,        // bytes done (scored by nominal size)
  total: 1,       // total bytes for this run
  fileDone: 0,    // bytes of the current file already fetched
  fileTotal: 0,   // total bytes of the current file (real value when the header has one)
  stage: "",      // what is happening now: "vision library" / "vision engine" / "pose model"
  step: 0,
  steps: 4,
  speed: 0,       // bytes per second
  t0: 0,
  woke: false,    // files are down, now waking the model up
  err: "",
};
function loaderPct() {
  if (loader.woke) return 1;
  if (!loader.total) return 0;
  const base = loader.done;
  const partial = loader.fileTotal ? Math.min(loader.fileTotal, loader.fileDone) : 0;
  return Math.max(0, Math.min(1, (base + partial) / loader.total));
}

// Live state of the camera pipeline, all shown on the diagnostic panel
const poseState = {
  model: false,
  live: false,
  person: false,
  fps: 0,
  detects: 0,
  lastOk: 0,
  err: "",
  delegate: "-",
  modelUrl: "-",
};

// ---------- Frozen frame: the camera image at the moment something is caught ----------
// Overwritten on every catch, so what is left at the end is the frame of the last catch.
// An in-memory canvas only: never uploaded, never written to disk (unless you press "Save this frame").
const snap = { canvas: null, ctx: null, label: "", ms: 0 };

function snapCamera(label = "") {
  if (video.readyState < 2 || !video.videoWidth) return null;
  if (!snap.canvas) {
    snap.canvas = document.createElement("canvas");
    snap.ctx = snap.canvas.getContext("2d");
  }
  if (snap.canvas.width !== video.videoWidth) {
    snap.canvas.width = video.videoWidth;
    snap.canvas.height = video.videoHeight;
  }
  const c = snap.ctx;
  c.save();
  c.translate(snap.canvas.width, 0); // saved mirrored, so it matches what you see in the mirror
  c.scale(-1, 1);
  c.drawImage(video, 0, 0);
  c.restore();
  snap.label = label;
  snap.ms = performance.now();
  return snap.canvas;
}

// ---------- Sound effects (Web Audio, no external assets) ----------
let audio = null;
function beep(freqs, type = "sine", dur = 0.12) {
  if (!audio) return;
  let t = audio.currentTime;
  for (const f of freqs) {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = type;
    osc.frequency.value = f;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.09, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(audio.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
    t += dur * 0.7;
  }
}
const sfxGrab = () => beep([660, 880], "triangle", 0.1);
const sfxBug = () => beep([300, 220, 150], "square", 0.08);
const sfxZap = () => beep([90, 1100, 70], "sawtooth", 0.14);
const sfxMiss = () => beep([220], "sine", 0.08);
const sfxWin = () => beep([523, 659, 784, 1047], "triangle", 0.14);
const sfxLose = () => beep([330, 220, 160], "sawtooth", 0.2);

// Touching a bug/plug shakes the whole browser window (not just the canvas)
let quakeTimer = 0;
function quakeWindow() {
  document.body.classList.remove("quake");
  void document.body.offsetWidth; // force a reflow so the animation replays
  document.body.classList.add("quake");
  clearTimeout(quakeTimer);
  quakeTimer = setTimeout(() => document.body.classList.remove("quake"), 720);
}

// short lines that pop up on screen
function addPop(text, pos, color = C.gold) {
  if (!game.pops) game.pops = [];
  game.pops.push({ text, x: pos.x, y: pos.y, color, t: 0 });
}

// ---------- How things are placed on the desk ----------
function place(items, kind, r, minGap, tries = 200) {
  for (let t = 0; t < tries; t++) {
    const p = {
      x: 70 + Math.random() * (W - 140),
      y: 104 + Math.random() * 232,   // the top strip is left for the in-canvas HUD and status line
    };
    if (Math.hypot(p.x - ANCHOR.x, p.y - ANCHOR.y) < 170) continue;
    if (items.some((it) => Math.hypot(it.x - p.x, it.y - p.y) < minGap)) continue;
    items.push({ kind, r, x: p.x, y: p.y, bob: Math.random() * Math.PI * 2 });
    return true;
  }
  return false;
}

function layout() {
  game.items = [];
  for (const kind of TREASURE_PLAN) place(game.items, kind, KIND[kind].r, 96);
  for (const kind of HAZARD_PLAN) place(game.items, kind, HAZARD[kind].r, 88);
}

function reset() {
  game.phase = "playing";
  game.score = 0;
  game.lives = 3;
  game.arm = { len: 0, dir: { x: 0, y: -1 }, mode: "idle", carry: null, lock: false };
  game.flash = 0;
  game.shake = 0;
  game.pops = [];
  game.debug = "";
  game.lean = 0;
  snap.canvas = null;   // don't keep the frozen frame from the previous round
  snap.label = "";
  layout();
  syncHud();
  if (game.input === "head") setStatus("Ready — shift your body left or right and her hand reaches that way");
  else if (game.input === "arm") setStatus("Ready — raise one arm diagonally up and hold it");
  else setStatus("Hold the mouse button and drag toward the jewellery");
}

// ---------- HUD ----------
// Score / tries / status are all drawn in the canvas; this only keeps a text copy for screen readers.
function syncHud() { /* the canvas reads game.score / game.lives every frame; no DOM sync needed */ }
function setStatus(text) {
  game.status = text;
  if (el.status) el.status.textContent = text;
}
// the in-canvas status line: only useful if it fits on one line, longer text is clipped
function drawStatusLine() {
  if (!game.status || (game.phase !== "playing" && game.phase !== "over")) return;
  const text = game.status;
  ctx.font = "600 15px system-ui";
  const w = Math.min(W - 40, ctx.measureText(text).width + 34);
  const x = W / 2 - w / 2, y = 58, h = 30;
  ink(rectPts(x, y, w, h), { fill: "rgba(255,244,220,0.94)", stroke: INK, lw: 3, seed: 71, amt: 2.4 });
  ctx.fillStyle = INK;
  ctx.textAlign = "center";
  ctx.fillText(text, W / 2, y + 20);
  ctx.textAlign = "left";
}

// ---------- Arm state machine ----------
function tipPos() {
  return {
    x: ANCHOR.x + game.arm.dir.x * game.arm.len,
    y: ANCHOR.y + game.arm.dir.y * game.arm.len,
  };
}

function reachLimit() {
  const d = game.arm.dir;
  let t = MAX_REACH;
  if (d.x > 0) t = Math.min(t, (W - 12 - ANCHOR.x) / d.x);
  if (d.x < 0) t = Math.min(t, (12 - ANCHOR.x) / d.x);
  if (d.y < 0) t = Math.min(t, (12 - ANCHOR.y) / d.y);
  return Math.max(0, t);
}

function relaxHint() {
  return game.input === "head" ? "back to the centre first, then lean left or right" : "lower your arm, then reach again";
}

function startRetract(reason) {
  game.arm.mode = "back";
  // Note: there is deliberately no "must release before reaching again" latch — as long as the person
  // keeps leaning, the arm reaches again once it is fully back; otherwise you get "arm is up but nothing happens".
  if (reason === "miss") {
    setStatus("Out of reach — the arm snaps back, " + relaxHint());
    sfxMiss();
  } else if (reason === "release") {
    setStatus("Let go — snapping back");
  }
}

function updateArm(dt, holding, dir) {
  const arm = game.arm;
  if (dir) arm.dir = dir;

  if (game.phase !== "playing") return;

  if (arm.mode === "idle" || arm.mode === "out") {
    if (holding) {
      if (arm.mode !== "out") game.hurtMsg = null;
      arm.mode = "out";
      arm.len += STRETCH_SPEED * dt;
      if (arm.len >= reachLimit()) {
        arm.len = reachLimit();
        startRetract("miss");
      }
    } else if (arm.mode === "out") {
      startRetract("release");
    }
  } else if (arm.mode === "back") {
    arm.len -= RETRACT_SPEED * dt;
    if (arm.len <= 0) {
      arm.len = 0;
      arm.mode = "idle";
      if (arm.carry) {
        game.score += 1;
        setStatus(`Found the ${KIND[arm.carry.kind].label}! +1`);
        addPop(`Found the ${KIND[arm.carry.kind].label}!`, tipPos(), C.gold);
        arm.carry = null;
        syncHud();
        if (game.items.filter((i) => !isHazard(i.kind)).length === 0) finish(true);
      } else if (game.phase === "playing") {
        if (game.hurtMsg) setStatus(game.hurtMsg);
        else if (game.input === "head") setStatus("Lean a bit further left or right — the arm reaches that way");
        else if (game.input === "arm") setStatus("Reach again — hold it higher, easier to hit");
        else setStatus("Hold the mouse button and try again");
      }
    }
  }

  // collision check
  if (arm.mode === "out") {
    const tip = tipPos();
    for (const it of game.items) {
      if (Math.hypot(it.x - tip.x, it.y - tip.y) < it.r + TIP_R) {
        game.items.splice(game.items.indexOf(it), 1);
        if (isHazard(it.kind)) {
          game.lives -= 1;
          const hurt = HAZARD[it.kind].label;
          if (it.kind === "bug") {
            game.flash = 0.55;
            game.flashColor = "74,209,79";         // bug: sickly green
            addPop("Ahh — a bug!", tipPos(), C.green);
            sfxBug();
          } else {
            game.flash = 0.55;
            game.flashColor = "30,123,232";        // plug: electric blue
            addPop("Ouch! It's live!", tipPos(), C.blue);
            sfxZap();
          }
          // shake the whole canvas and the whole window
          game.shake = 0.75;
          quakeWindow();
          arm.mode = "back";
          const left = Math.max(game.lives, 0);
          setStatus(`Touched a ${hurt}! Hand snapped back — ${left} ${left === 1 ? "try" : "tries"} left`);
          if (game.lives > 0) game.hurtMsg = `That was a ${hurt} — ${relaxHint()}`;
          syncHud();
          if (game.lives <= 0) finish(false);
        } else {
          arm.carry = it;
          arm.mode = "back";
          sfxGrab();
          snapCamera(KIND[it.kind].label); // freeze this moment (after the last overwrite it is "the last one")
          setStatus(`Got the ${KIND[it.kind].label} — reeling it in`);
        }
        break;
      }
    }
  }
}

function finish(won) {
  game.phase = "over";
  game.arm.mode = "back";
  // ending with nothing caught (e.g. all three tries spent on hazards): keep at least one frame of the moment
  if (!snap.canvas) snapCamera("");
  syncHud();
  if (won) {
    setStatus(`All the jewellery is back! ${game.score} pieces`);
    sfxWin();
  } else {
    setStatus("Oh dear, worn out — let's look again");
    sfxLose();
  }
}

// ---------- Camera / pose ----------
let poseLandmarker = null;
let lastVideoTime = -1;
let lastInput = { holding: false, dir: null };   // last valid result (used for debouncing)
const HOLD_MS = 400;                              // how long the last result is kept after detection is lost

// ---------- Downloading with progress ----------
// Fetched files are stored with the Cache API: on the same machine the next open is instant, no second 15 MB.
let diskCache;
async function getCache() {
  if (diskCache !== undefined) return diskCache;
  try {
    diskCache = (window.caches && (await caches.open("stretch-miner-v1"))) || null;
  } catch {
    diskCache = null;
  }
  return diskCache;
}

// read file by file, reporting byte counts to the progress bar as we go
async function fetchWithProgress(file, token) {
  const cache = await getCache();
  if (cache) {
    try {
      const hit = await cache.match(file.url);
      if (hit) {
        loader.fileTotal = file.size;
        loader.fileDone = file.size;   // already local: count this step as done
        return new Uint8Array(await hit.arrayBuffer());
      }
    } catch { /* cache unavailable: just download */ }
  }

  const res = await fetch(file.url);
  if (!res.ok) throw new Error(`${res.status} · ${file.url.split("/").pop()}`);
  const total = Number(res.headers.get("content-length")) || file.size;
  loader.fileTotal = total;
  loader.fileDone = 0;

  let out;
  if (res.body && res.body.getReader) {
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0, n = 0;
    const t0 = performance.now();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (token !== loadToken) {
        try { await reader.cancel(); } catch { /* ignore */ }
        throw new Error("cancelled");
      }
      chunks.push(value);
      got += value.length;
      loader.fileDone = got;
      loader.speed = got / Math.max(0.25, (performance.now() - t0) / 1000);
      if (++n % 8 === 0) await new Promise((r) => setTimeout(r, 0)); // give the frame a chance to repaint
    }
    out = new Uint8Array(got);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
  } else {
    out = new Uint8Array(await res.arrayBuffer());
    loader.fileDone = out.length;
  }

  if (cache) {
    try { await cache.put(file.url, new Response(out.slice())); } catch { /* cannot store it, never mind */ }
  }
  return out;
}

async function loadPose() {
  if (poseLandmarker) return poseLandmarker;
  let lastErr = null;
  const token = loadToken;

  for (const src of SOURCES) {
    for (const modelUrl of src.models) {
      if (token !== loadToken) return null;
      const plan = [
        { key: "lib", label: "vision library", url: src.lib, size: SIZE.lib },
        { key: "loader", label: "vision engine", url: `${src.wasm}/vision_wasm_internal.js`, size: SIZE.loader },
        { key: "wasm", label: "vision engine", url: `${src.wasm}/vision_wasm_internal.wasm`, size: SIZE.wasm },
        {
          key: "model",
          label: "pose model",
          url: modelUrl,
          size: modelUrl.includes("full") ? SIZE.modelFull : SIZE.modelLite,
        },
      ];
      loader.total = plan.reduce((a, f) => a + f.size, 0);
      loader.done = 0;
      loader.fileDone = 0;
      loader.fileTotal = 0;
      loader.speed = 0;
      loader.steps = plan.length;
      loader.step = 0;
      try {
        const bytes = {};
        for (const f of plan) {
          loader.stage = f.label;
          loader.step += 1;
          bytes[f.key] = await fetchWithProgress(f, token);
          loader.done += f.size;
          loader.fileDone = 0;
          loader.fileTotal = 0;
          if (token !== loadToken) return null;
        }
        loader.woke = true;
        loader.stage = "waking the model";
        // the library was already fetched (browser cache), import it by its original URL
        const lib = await import(/* @vite-ignore */ src.lib);
        const fileset = await lib.FilesetResolver.forVisionTasks(src.wasm);
        for (const delegate of ["GPU", "CPU"]) {
          try {
            poseLandmarker = await lib.PoseLandmarker.createFromOptions(fileset, {
              baseOptions: { modelAssetBuffer: bytes.model, delegate },
              runningMode: "VIDEO",
              numPoses: 1,
              minPoseDetectionConfidence: 0.4,
              minPosePresenceConfidence: 0.4,
              minTrackingConfidence: 0.4,
            });
            poseState.model = true;
            poseState.delegate = delegate;
            poseState.lib = src.name;
            poseState.modelUrl = `${src.name}·${modelUrl.includes("lite") ? "lite" : "full"}`;
            return poseLandmarker;
          } catch (err) {
            lastErr = err;
            poseLandmarker = null;
          }
        }
      } catch (err) {
        lastErr = err;
      }
      loader.woke = false;
    }
  }
  poseState.err = String(lastErr || "unknown");
  throw lastErr || new Error("pose model failed");
}

let loadToken = 0;   // bumped on every "back to home", so a download still in flight cancels itself

async function startCamera(mode = "head") {
  if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
  game.input = mode;
  if (poseLandmarker) { reset(); return; }   // model already loaded: play right away, no wait

  // show something moving right away so it never looks frozen
  game.phase = "loading";
  loader.on = true;
  loader.err = "";
  loader.woke = false;
  loader.done = 0;
  loader.fileDone = 0;
  loader.fileTotal = 0;
  loader.speed = 0;
  loader.stage = "opening the camera";
  loader.step = 0;
  loader.steps = 4;
  setStatus("");

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
    video.srcObject = stream;
    await video.play();
    await new Promise((res) => {
      if (video.readyState >= 2) return res();
      video.onloadeddata = res;
      setTimeout(res, 3000);
    });
  } catch (err) {
    poseState.err = "getUserMedia: " + (err && err.name ? err.name : err);
    loader.on = false;
    setStatus("Camera unavailable or denied — switched to mouse mode");
    startMouse();
    return;
  }

  loadToken += 1;
  try {
    await loadPose();
  } catch (err) {
    loader.on = false;
    loader.err = String(err);
    setStatus("Pose model could not be fetched — switched to mouse mode");
    startMouse();
    return;
  }
  if (game.phase !== "loading") return;   // "back to home" was pressed midway
  loader.on = false;
  reset();
}

function goHome() {
  loadToken += 1;          // cancel a download that is still running
  loader.on = false;
  game.phase = "home";
  game.input = "none";
  game.arm.mode = "idle";
  game.arm.len = 0;
  game.arm.carry = null;
  if (video.srcObject) {
    video.srcObject.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  }
  poseState.person = false;
  setStatus("");
}

function startMouse() {
  if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
  loader.on = false;
  game.input = "mouse";
  reset();
}

// normalised coords -> mirrored, because the frame behaves like a mirror
const mirror = (p) => ({ x: 1 - p.x, y: p.y });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function readPose(ts) {
  poseState.live = video.readyState >= 2;
  if (!poseLandmarker) return null;
  if (video.readyState < 2) return null;
  // never run inference twice on the same video frame; returning null here means the caller reuses
  // the previous result — do NOT read it as "the person let go" (that was the old arm-lock bug)
  if (video.currentTime === lastVideoTime) return null;
  lastVideoTime = video.currentTime;

  let res;
  try {
    res = poseLandmarker.detectForVideo(video, ts);
  } catch (err) {
    poseState.err = "detect: " + err;
    return null;
  }
  poseState.detects += 1;
  const lm = res.landmarks && res.landmarks[0];
  if (!lm || lm.length < 25) {
    poseState.person = false;
    return null;
  }
  poseState.person = true;
  poseState.lastOk = performance.now();
  game.seenPerson = true;

  const out = game.input === "head" ? readHead(lm) : readArm(lm);
  lastInput = out;
  return out;
}

// Hands-free: how far the body midline (shoulder midpoint, weighted with the nose when visible) is off centre
// whichever way you shift, the arm reaches that way diagonally up; back to centre and it snaps back
function readHead(lm) {
  const nose = mirror(lm[0]);
  const ls = mirror(lm[11]), rs = mirror(lm[12]);
  const lh = mirror(lm[23]), rh = mirror(lm[24]);
  const shoulderX = (ls.x + rs.x) / 2;
  const hipX = (lh.x + rh.x) / 2;
  const torsoX = (shoulderX + hipX) / 2;

  const noseOk = !lm[0].visibility || lm[0].visibility > 0.5;
  const raw = noseOk ? nose.x * 0.5 + torsoX * 0.5 : torsoX;
  game.trackX = raw;

  const lean = Math.max(-0.5, Math.min(0.5, raw - game.centerX)); // positive = toward the right of frame
  game.lean = lean;

  const th = thresholds();
  const out = game.arm.mode === "out";
  const need = out ? th.leanKeep : th.leanStart;
  const holding = Math.abs(lean) > need;

  // past the threshold it sweeps starting from straight up, widening as you lean further — so the middle is reachable
  // dead is pinned to leanStart (not the hysteretic need), otherwise the direction jumps at the trigger moment
  const dead = th.leanStart;
  const over = Math.max(0, Math.abs(lean) - dead);
  const span = Math.max(0.06, 0.45 - dead);
  const t = Math.min(1, over / span);
  const tilt = Math.sign(lean) * (MIN_TILT + t * (MAX_TILT - MIN_TILT));
  const dir = { x: Math.sin(tilt), y: -Math.cos(tilt) };

  game.debug = `lean ${lean > 0 ? "right" : "left"} ${Math.abs(lean * 100).toFixed(0)}% (threshold ${(need * 100).toFixed(0)}%) · ${holding ? "reaching" : "back"}`;
  return { holding, dir };
}

// Arm control: pick the hand raised higher and use its direction as the arm direction
function readArm(lm) {
  const ls = mirror(lm[11]), rs = mirror(lm[12]);
  const lw = mirror(lm[15]), rw = mirror(lm[16]);
  const lh = mirror(lm[23]), rh = mirror(lm[24]);
  const shMid = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };
  const hipMid = { x: (lh.x + rh.x) / 2, y: (lh.y + rh.y) / 2 };
  const U = Math.max(dist(shMid, hipMid), 0.08); // torso length used as the unit
  const aspect = (video.videoWidth || 4) / (video.videoHeight || 3);

  let best = null;
  for (const [s, w] of [[ls, lw], [rs, rw]]) {
    const v = { x: (w.x - s.x) * aspect, y: w.y - s.y };
    const len = Math.hypot(v.x, v.y) / U;
    const up = -v.y / U; // up is positive
    if (!best || up > best.score) best = { v, len, up, score: up };
  }

  const th = thresholds();
  const out = game.arm.mode === "out";
  const needUp = out ? th.needUp * 0.5 : th.needUp;
  const needLen = out ? th.needLen * 0.75 : th.needLen;
  const holding = best.up > needUp && best.len > needLen;

  let dir = null;
  if (holding || out) {
    const m = Math.hypot(best.v.x, best.v.y) || 1;
    let dx = best.v.x / m;
    let dy = best.v.y / m;
    if (dy > -0.18) dy = -0.18; // only the two upper quadrants are allowed
    const mm = Math.hypot(dx, dy);
    dir = { x: dx / mm, y: dy / mm };
  }
  game.armInfo = `arm ${best.len.toFixed(2)}/${needLen.toFixed(2)} · raise ${best.up.toFixed(2)}/${needUp.toFixed(2)}`;
  game.debug = game.armInfo + ` · ${holding ? "out" : "back"}`;
  return { holding, dir };
}

// ---------- Mouse mode ----------
const mouse = { active: false, x: W / 2, y: 200 };
function mouseInput() {
  const dx = mouse.x - ANCHOR.x;
  const dy = mouse.y - ANCHOR.y;
  const m = Math.hypot(dx, dy) || 1;
  let ux = dx / m;
  let uy = dy / m;
  if (uy > -0.18) uy = -0.18;
  const mm = Math.hypot(ux, uy);
  return { holding: mouse.active, dir: { x: ux / mm, y: uy / mm } };
}

// Fixed positions of the two controls on the in-canvas HUD (canvas coords)
const HUD_BAR = { x: 14, y: 10, w: W - 28, h: 48 };
const SENS_BAR = { x: 500, y: 30, w: 130 };   // sensitivity slider track
const BTN_CAL = { x: 648, y: 18, w: 104, h: 32 };
const BTN_HOME = { x: 764, y: 18, w: 74, h: 32 };

function setSensFromX(x) {
  const t = Math.max(0, Math.min(1, (x - SENS_BAR.x) / SENS_BAR.w));
  sens = Math.round(t * 100) / 100;
}

canvas.addEventListener("pointerdown", (e) => {
  const p = canvasPoint(e);
  ui.hover = { x: p.x, y: p.y, on: true };
  ui.click = { x: p.x, y: p.y };   // in-canvas buttons are hit-tested while this frame is drawn

  // dragging the sensitivity slider: don't let it count as a button click or as reaching
  if (game.phase === "playing" &&
      inRect(p, SENS_BAR.x - 12, SENS_BAR.y - 14, SENS_BAR.w + 24, 32)) {
    ui.click = null;
    ui.drag = "sens";
    setSensFromX(p.x);
    try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    return;
  }
  // mouse mode: holding anywhere below the HUD = reaching
  if (game.input === "mouse" && game.phase === "playing" && p.y > HUD_BAR.y + HUD_BAR.h + 6) {
    mouse.active = true;
    setPointer(p);
    try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  }
});
canvas.addEventListener("pointermove", (e) => {
  const p = canvasPoint(e);
  ui.hover = { x: p.x, y: p.y, on: true };
  if (ui.drag === "sens") setSensFromX(p.x);
  else if (game.input === "mouse" && game.phase === "playing") setPointer(p);
});
canvas.addEventListener("pointerleave", () => {
  ui.hover = { x: -999, y: -999, on: false };
});
window.addEventListener("pointerup", () => { mouse.active = false; ui.drag = null; });
function canvasPoint(e) {
  const r = canvas.getBoundingClientRect();
  return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
}
function setPointer(p) {
  mouse.x = p.x;
  mouse.y = p.y;
}

// ---------- Drawing ----------
let deskLayer = null;

function squiggle(x1, y1, x2, y2, color = INK, lw = 2, amp = 3, seed = 1) {
  const pts = [];
  for (let i = 0; i <= 12; i++) {
    const t = i / 12;
    pts.push({ x: x1 + (x2 - x1) * t, y: y1 + (y2 - y1) * t + (_h(seed + i * 3.1) - 0.5) * amp });
  }
  ink(pts, { stroke: color, lw, close: false, seed, amt: 1.2, passes: 1 });
}

function flower(cx, cy, r, petal = C.magenta, core = C.yellow, seed = 1) {
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
    disc(cx + Math.cos(a) * r * 0.85, cy + Math.sin(a) * r * 0.85, r * 0.6,
      { fill: petal, stroke: INK, lw: 2.2, seed: seed + i, amt: 1.6, passes: 1 });
  }
  disc(cx, cy, r * 0.45, { fill: core, stroke: INK, lw: 2, seed: seed + 9, amt: 1.2, passes: 1 });
}

// a thick pen pass with a thinner pass on top: every arm/line uses this so it keeps an outlined look
function thickLine(x1, y1, x2, y2, color, w) {
  pen.lineCap = "round";
  pen.lineJoin = "round";
  pen.strokeStyle = INK;
  pen.lineWidth = w + 5;
  pen.beginPath(); pen.moveTo(x1, y1); pen.lineTo(x2, y2); pen.stroke();
  pen.strokeStyle = color;
  pen.lineWidth = w;
  pen.beginPath(); pen.moveTo(x1, y1); pen.lineTo(x2, y2); pen.stroke();
}

// ---------- The cluttered desk (painted once into an offscreen layer) ----------
function buildDesk() {
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const prev = pen;
  pen = c.getContext("2d");
  paintDesk();
  pen = prev;
  deskLayer = c;
}

function paintDesk() {
  pen.fillStyle = C.wood;
  pen.fillRect(0, 0, W, H);
  pen.lineCap = "round";
  for (let i = 0; i < 30; i++) {
    const y = (i / 30) * (H + 60) - 30;
    pen.strokeStyle = i % 3 === 0 ? "rgba(180,95,28,0.42)" : "rgba(255,209,63,0.22)";
    pen.lineWidth = 2 + (i % 3);
    pen.beginPath();
    pen.moveTo(-10, y);
    for (let x = 0; x <= W + 20; x += 90) pen.lineTo(x, y + Math.sin(x / 150 + i * 0.7) * 5);
    pen.stroke();
  }

  // a spread of old newspaper: a slightly cleaner stage for the jewellery
  pen.save();
  pen.translate(W / 2, 212);
  pen.rotate(-0.024);
  ink(rectPts(-432, -172, 864, 336), { fill: C.cream, stroke: "#C0884B", lw: 3.5, seed: 3, amt: 3.4 });
  ink(rectPts(-424, -164, 864, 336), { stroke: "#E4CFA6", lw: 2, seed: 8, amt: 2.6, passes: 1 });
  squiggle(-400, -144, -170, -144, C.red, 7, 4, 11);
  squiggle(-400, -132, -230, -132, C.red, 3, 3, 12);
  for (let row = 0; row < 9; row++) {
    const y = -106 + row * 33;
    squiggle(-402, y, -30, y, "#BCA987", 2, 2.6, 20 + row);
    squiggle(10, y, 300, y, "#BCA987", 2, 2.6, 40 + row);
    squiggle(330, y, 412, y, "#BCA987", 2, 2.6, 60 + row);
  }
  pen.restore();

  paintClutter();
}

function paintClutter() {
  // top left: enamel teacup with a wisp of steam
  (function cup(x, y, s) {
    disc(x, y + 54 * s, 42 * s, { fill: C.pink, stroke: INK, lw: 3, squash: 0.4, seed: 101 });
    ink(rectPts(x - 32 * s, y - 6 * s, 64 * s, 52 * s), { fill: C.teal, stroke: INK, lw: 3.2, seed: 100 });
    roughArc(x, y - 4 * s, 32 * s, Math.PI, Math.PI * 2, { stroke: INK, lw: 3, seed: 102, n: 8 });
    roughArc(x, y + 34 * s, 30 * s, 0, Math.PI, { stroke: INK, lw: 2.4, seed: 103, n: 8 });
    bar(x + 32 * s, y + 8 * s, x + 50 * s, y + 26 * s, INK, 5, 104);
    bar(x + 34 * s, y + 26 * s, x + 32 * s, y + 8 * s, C.teal, 3, 104);
    squiggle(x - 10 * s, y - 16 * s, x - 4 * s, y - 46 * s, "#8C7BB5", 3, 5, 105);
    squiggle(x + 12 * s, y - 14 * s, x + 18 * s, y - 40 * s, "#8C7BB5", 3, 5, 106);
  })(104, 70, 1.0);

  // top right: medicine bottles
  (function bottles(x, y, s) {
    for (let i = 0; i < 3; i++) {
      const bx = x + i * 40 * s;
      const bh = (58 - i * 9) * s;
      ink(rectPts(bx - 17 * s, y - bh, 34 * s, bh), {
        fill: [C.yellow, C.orange, C.lilac][i], stroke: INK, lw: 3, seed: 110 + i,
      });
      ink(rectPts(bx - 12 * s, y - bh - 11 * s, 24 * s, 12 * s), {
        fill: C.red, stroke: INK, lw: 2.6, seed: 120 + i, amt: 1.4,
      });
      squiggle(bx - 12 * s, y - bh * 0.45, bx + 12 * s, y - bh * 0.45, "#FFFFFF", 2.4, 2, 130 + i);
    }
    // pills spilled out
    for (let i = 0; i < 5; i++) {
      disc(x - 30 * s + i * 22 * s, y + 14 * s + _h(i) * 10, 6, {
        fill: i % 2 ? C.cream : C.yellow, stroke: INK, lw: 2, seed: 140 + i, n: 10, amt: 1.2, passes: 1,
      });
    }
  })(790, 150, 1.0);

  // bottom left: ball of yarn and two knitting needles
  (function yarn(x, y, s) {
    disc(x, y, 46 * s, { fill: C.magenta, stroke: INK, lw: 3.4, seed: 200 });
    for (let i = 0; i < 6; i++) {
      roughArc(x, y, 30 * s + i * 3 * s, i * 0.7, i * 0.7 + 2.6, {
        stroke: "rgba(43,21,51,0.55)", lw: 2, seed: 210 + i, n: 7, passes: 1,
      });
    }
    bar(x + 20 * s, y - 30 * s, x + 84 * s, y - 78 * s, C.lilac, 5, 220);
    bar(x + 26 * s, y - 20 * s, x + 92 * s, y - 62 * s, C.lilac, 5, 221);
    disc(x + 86 * s, y - 80 * s, 7 * s, { fill: C.yellow, stroke: INK, lw: 2, seed: 222, n: 8 });
    squiggle(x - 50 * s, y + 40 * s, x + 30 * s, y + 66 * s, C.magenta, 3, 6, 223);
  })(120, 548, 1.0);

  // bottom right: a stack of letters and postcards
  (function letters(x, y, s) {
    for (let i = 0; i < 4; i++) {
      ink(rectPts(x - 60 * s + i * 5 * s, y - 44 * s + i * 12 * s, 120 * s, 58 * s), {
        fill: [C.cream, C.lilac, C.pink, C.cream][i], stroke: INK, lw: 2.8, seed: 230 + i, amt: 2.4,
      });
    }
    disc(x + 34 * s, y - 2 * s, 13 * s, { fill: C.red, stroke: INK, lw: 2.4, seed: 240, n: 10 });
    squiggle(x - 46 * s, y + 2 * s, x + 6 * s, y + 4 * s, "#B9905A", 2, 2, 241);
    squiggle(x - 46 * s, y + 12 * s, x - 4 * s, y + 14 * s, "#B9905A", 2, 2, 242);
  })(846, 548, 1.0);

  // scattered buttons, a spool and a thimble
  (function bits() {
    for (let i = 0; i < 16; i++) {
      const x = 40 + _h(i * 3.7) * (W - 80);
      const y = 40 + _h(i * 9.1 + 3) * (H - 90);
      const cols = [C.teal, C.magenta, C.yellow, C.blue, C.orange, C.purple];
      disc(x, y, 6 + _h(i) * 4, {
        fill: cols[i % cols.length], stroke: INK, lw: 2, seed: 260 + i, n: 10, amt: 1.2, passes: 1,
      });
      if (i % 3 === 0) {
        bar(x - 3, y - 2, x - 1, y + 2, INK, 1.6, 270 + i);
        bar(x + 1, y - 2, x + 3, y + 2, INK, 1.6, 271 + i);
      }
    }
    // spool + thimble
    ink(rectPts(206, 600, 34, 40), { fill: C.yellow, stroke: INK, lw: 3, seed: 280 });
    disc(223, 594, 20, { fill: C.orange, stroke: INK, lw: 2.4, squash: 0.4, seed: 281 });
    disc(748, 610, 15, { fill: C.teal, stroke: INK, lw: 2.6, squash: 0.85, seed: 282, n: 12 });
  })();
}

// ---------- Things on the desk ----------
function halo(radius, color, it, alpha = 0.55) {
  pen.save();
  const k = 0.35 + 0.28 * Math.sin(performance.now() / 420 + it.bob);
  pen.globalAlpha = Math.max(0, k * alpha + 0.18);
  disc(0, 0, radius, { stroke: color, lw: 3, seed: it.bob * 13, passes: 1, n: 20 });
  pen.restore();
}

function drawItem(it) {
  const bobY = it.y + Math.sin(performance.now() / 700 + it.bob) * 3;
  pen.save();
  pen.translate(it.x, bobY);
  pen.rotate(Math.sin(it.bob) * 0.09);           // every object is tilted a little, so nothing looks like an icon
  if (isHazard(it.kind)) drawHazardArt(it);
  else drawTreasureArt(it);
  pen.restore();
}

function drawTreasureArt(it) {
  const r = it.r;
  halo(r + 12, C.cream, it);
  switch (it.kind) {
    case "glasses": {
      const L = r * 0.5;
      bar(-L - 8, -3, -r * 1.15, -r * 0.6, INK, 4.5, 21);
      bar(L + 8, -3, r * 1.15, -r * 0.6, INK, 4.5, 22);
      disc(-L - 3, 0, L, { fill: "rgba(125,227,244,0.6)", stroke: C.magenta, lw: 4.5, seed: 23 });
      disc(L + 3, 0, L, { fill: "rgba(125,227,244,0.6)", stroke: C.magenta, lw: 4.5, seed: 24 });
      thickLine(-4, 0, 4, 0, C.magenta, 4);
      bar(-L - 8, -L * 0.45, -L + 3, -L * 0.05, "#FFFFFF", 3, 26);
      bar(L + 2, -L * 0.5, L + 10, -L * 0.1, "#FFFFFF", 3, 27);
      break;
    }
    case "necklace": {
      const R = r * 0.82, cy = -r * 0.34;
      roughArc(0, cy, R, Math.PI * 0.1, Math.PI * 0.9, { stroke: C.gold, lw: 4.5, seed: 31, n: 14 });
      for (let i = 0; i <= 6; i++) {
        const a = Math.PI * (0.1 + 0.8 * (i / 6));
        disc(Math.cos(a) * R, cy + Math.sin(a) * R, 3.4, {
          fill: i % 2 ? C.magenta : C.teal, stroke: INK, lw: 1.8, seed: 32 + i, n: 8, amt: 1, passes: 1,
        });
      }
      const py = cy + R + 6;
      thickLine(0, cy + R, 0, py - 4, C.gold, 3);
      ink(ringPts(0, py, r * 0.3, 12), { fill: C.purple, stroke: INK, lw: 3, seed: 40 });
      disc(-r * 0.1, py - r * 0.1, r * 0.1, { fill: C.yellow, stroke: null, seed: 41, n: 8 });
      break;
    }
    case "earring": {
      disc(0, -r * 0.15, r * 0.6, { fill: null, stroke: C.gold, lw: 5.5, seed: 51, n: 18 });
      roughArc(0, -r * 0.15 - r * 0.6, r * 0.2, Math.PI * 0.15, Math.PI * 0.85, { stroke: C.gold, lw: 3, seed: 52, n: 6 });
      thickLine(0, r * 0.35, 0, r * 0.52, C.gold, 3);
      ink(ringPts(0, r * 0.75, r * 0.3, 12), { fill: C.red, stroke: INK, lw: 2.6, seed: 53 });
      disc(-r * 0.1, r * 0.68, r * 0.08, { fill: C.cream, stroke: null, seed: 54, n: 8 });
      break;
    }
    case "ring": {
      disc(0, r * 0.28, r * 0.66, { fill: null, stroke: C.gold, lw: 7, seed: 61, n: 18, squash: 0.86 });
      disc(0, r * 0.28, r * 0.4, { fill: null, stroke: "#8A5A00", lw: 2, seed: 62, n: 14, passes: 1 });
      ink([{ x: 0, y: -r * 1.0 }, { x: r * 0.42, y: -r * 0.42 }, { x: 0, y: -r * 0.05 }, { x: -r * 0.42, y: -r * 0.42 }],
        { fill: C.teal, stroke: INK, lw: 3, seed: 63, amt: 1.6 });
      bar(-r * 0.42, -r * 0.42, r * 0.42, -r * 0.42, "#D7F6FD", 2.4, 64);
      break;
    }
    case "brooch": {
      flower(0, 0, r * 0.85, C.magenta, C.yellow, 71);
      ink(ringPts(0, 0, r * 0.3, 10), { fill: C.teal, stroke: INK, lw: 2.6, seed: 78 });
      break;
    }
    default: { // hairpin
      const x1 = -r * 0.95, y1 = r * 0.85, x2 = r * 0.4, y2 = -r * 0.85;
      thickLine(x1, y1, x2, y2, C.pink, 5);
      flower(x1 + 2, y1, r * 0.5, C.orange, C.yellow, 83);
      for (let i = 0; i < 3; i++) {
        disc(x2 - i * 5, y2 + i * 9, 3.4, {
          fill: C.purple, stroke: INK, lw: 1.6, seed: 90 + i, n: 8, amt: 1, passes: 1,
        });
      }
    }
  }
}

function drawHazardArt(it) {
  const r = it.r;
  const t = performance.now();
  if (it.kind === "bug") {
    halo(r + 11, C.green, it, 0.5);
    const wig = Math.sin(t / 150 + it.bob) * 3;
    for (let i = 0; i < 3; i++) {
      const bx = -r * 0.42 + i * r * 0.42;
      for (const s of [-1, 1]) {
        bar(bx, s * r * 0.28, bx + s * r * 0.45 + wig, s * r * 0.95, INK, 3.4, 120 + i * 2 + (s > 0 ? 1 : 0));
      }
    }
    disc(0, 0, r * 0.76, { fill: C.green, stroke: INK, lw: 3.4, seed: 140, squash: 0.82, n: 16 });
    bar(-r * 0.5, 0, r * 0.5, 0, INK, 2.6, 141);
    for (let i = 0; i < 3; i++) {
      disc(-r * 0.3 + i * r * 0.3, -r * 0.26, 3.4, {
        fill: C.magenta, stroke: null, seed: 150 + i, n: 8, amt: 1, passes: 1,
      });
    }
    // head + antennae
    disc(-r * 0.88, 0, r * 0.3, { fill: C.purple, stroke: INK, lw: 2.6, seed: 160, n: 10 });
    bar(-r * 1.05, -r * 0.1, -r * 1.45, -r * 0.62, INK, 2.6, 161);
    bar(-r * 1.05, r * 0.1, -r * 1.5, r * 0.58, INK, 2.6, 162);
  } else {
    halo(r + 11, C.blue, it, 0.5);
    // the trailing cord
    const cord = [];
    for (let i = 0; i <= 10; i++) {
      const u = i / 10;
      cord.push({ x: r * 0.5 + u * r * 1.0, y: r * 0.55 + Math.sin(u * 3.2 + 1) * r * 0.45 });
    }
    ink(cord, { stroke: INK, lw: 9, close: false, seed: 170, amt: 1.4, passes: 1 });
    ink(cord, { stroke: C.deep, lw: 5, close: false, seed: 171, amt: 1.4, passes: 1 });
    // plug body + two prongs
    ink(rectPts(-r * 0.72, -r * 0.3, r * 1.4, r * 1.0), { fill: "#3A2F4A", stroke: INK, lw: 3.4, seed: 175, amt: 2.4 });
    ink(rectPts(-r * 0.45, -r * 1.02, r * 0.24, r * 0.78), { fill: C.gold, stroke: INK, lw: 2.6, seed: 176, amt: 1.4 });
    ink(rectPts(r * 0.2, -r * 1.02, r * 0.24, r * 0.78), { fill: C.gold, stroke: INK, lw: 2.6, seed: 177, amt: 1.4 });
    // bare copper wire, crackling sparks
    bar(-r * 0.9, r * 0.25, r * 0.4, r * 0.62, C.orange, 4.5, 178);
    bar(-r * 0.9, r * 0.62, r * 0.5, r * 0.3, C.orange, 4.5, 179);
    const f = Math.floor(t / 110);
    if (f % 3 !== 2) {
      for (let i = 0; i < 4; i++) {
        const a = -Math.PI * 0.85 + i * 0.55;
        const len = r * (0.45 + 0.55 * _h(f + i * 2.3));
        bar(-r * 0.25, r * 0.45, -r * 0.25 + Math.cos(a) * len, r * 0.45 + Math.sin(a) * len, C.yellow, 3, 180 + i);
      }
    }
  }
}

// ---------- Granny (the camera panel is her face) ----------
function drawShawl() {
  const { x, y, w, h } = PANEL;
  const sy = y + h * 0.66;             // the shawl rises from 1/3 up the panel's bottom edge = her shoulders
  ink([
    { x: x - 40, y: y + h + 26 },
    { x: x - 6, y: sy + 6 },
    { x: x + w / 2, y: sy - 6 },
    { x: x + w + 6, y: sy + 6 },
    { x: x + w + 40, y: y + h + 26 },
  ], { fill: C.teal, stroke: INK, lw: 4, seed: 350, amt: 3 });
  // knit ribbing
  for (let i = 0; i < 4; i++) {
    const ry = sy + 14 + i * (h * 0.3 / 4);
    const inset = 26 + i * 10;
    bar(x + inset, ry, x + w - inset, ry + 6, "rgba(255,255,255,0.3)", 3, 360 + i);
  }
  // collar trim
  for (let i = 0; i < 10; i++) {
    const t = i / 9;
    const bx = x - 2 + t * (w + 4);
    const by = sy - 6 + Math.sin(t * Math.PI) * 14;
    disc(bx, by, 3.4, { fill: C.magenta, stroke: INK, lw: 1.6, seed: 370 + i, n: 8, amt: 1, passes: 1 });
  }
}

function drawGranny() {
  const { x, y, w, h } = PANEL;
  ink(rectPts(x - 13, y - 13, w + 26, h + 26), { fill: null, stroke: C.gold, lw: 6, seed: 300, amt: 3 });
  ink(rectPts(x - 6, y - 6, w + 12, h + 12), { fill: null, stroke: C.magenta, lw: 2.4, seed: 301, amt: 3, passes: 1 });
  flower(x - 13, y - 13, 12, C.magenta, C.yellow, 310);
  flower(x + w + 13, y - 13, 12, C.teal, C.yellow, 320);
  flower(x - 13, y + h * 0.5, 11, C.orange, C.yellow, 330);
  flower(x + w + 13, y + h * 0.5, 11, C.purple, C.yellow, 340);
  // white hair on both sides
  for (const side of [-1, 1]) {
    for (let i = 0; i < 5; i++) {
      disc(x + (side > 0 ? w + 5 : -5), y + 30 + i * 40, 16 - i * 1.4, {
        fill: "#FAF3E7", stroke: INK, lw: 2.4, seed: 500 + side * 7 + i, amt: 2, passes: 1,
      });
    }
  }
  drawShawl();
}

// ---------- The reaching hand ----------
function drawArm() {
  const arm = game.arm;
  if (arm.len <= 3) return;
  const tip = tipPos();
  const mx = ANCHOR.x + arm.dir.x * arm.len * 0.5;
  const my = ANCHOR.y + arm.dir.y * arm.len * 0.5;
  const ang = Math.atan2(arm.dir.y, arm.dir.x);

  // knitted sleeve
  thickLine(ANCHOR.x, ANCHOR.y + 10, mx, my, C.magenta, 22);
  const nx = Math.cos(ang + Math.PI / 2), ny = Math.sin(ang + Math.PI / 2);
  pen.strokeStyle = "rgba(43,21,51,0.55)";
  pen.lineWidth = 2.4;
  for (let i = -3; i <= 3; i++) {
    const bx = mx + nx * i * 6, by = my + ny * i * 6;
    pen.beginPath();
    pen.moveTo(bx - arm.dir.x * 9, by - arm.dir.y * 9);
    pen.lineTo(bx + arm.dir.x * 9, by + arm.dir.y * 9);
    pen.stroke();
  }

  // forearm + age spots
  thickLine(mx, my, tip.x, tip.y, C.skin, 13);
  for (let i = 0; i < 4; i++) {
    const u = 0.2 + i * 0.2;
    disc(mx + (tip.x - mx) * u + nx * 3, my + (tip.y - my) * u + ny * 3, 2.2, {
      fill: C.skinShade, stroke: null, seed: 430 + i, n: 6, amt: 1, passes: 1,
    });
  }

  // hand: fingers close when holding something, stay open otherwise
  const spread = arm.carry ? 0.34 : 0.9;
  disc(tip.x, tip.y, 11, { fill: C.skin, stroke: INK, lw: 3, seed: 400, n: 12 });
  for (let i = -2; i <= 2; i++) {
    const a = ang + (i / 2) * spread;
    const fx = tip.x + Math.cos(a) * 14, fy = tip.y + Math.sin(a) * 14;
    thickLine(tip.x, tip.y, fx, fy, C.skin, 5.5);
  }
}

function drawPops() {
  if (!game.pops) return;
  pen.textAlign = "center";
  pen.font = "600 21px system-ui";
  pen.lineJoin = "round";
  for (const p of game.pops) {
    const k = Math.min(1, p.t / 1.1);
    const y = p.y - 26 - k * 40;
    pen.globalAlpha = Math.max(0, 1 - k * k);
    pen.strokeStyle = INK;
    pen.lineWidth = 5;
    pen.strokeText(p.text, p.x, y);
    pen.fillStyle = p.color;
    pen.fillText(p.text, p.x, y);
  }
  pen.globalAlpha = 1;
  pen.textAlign = "left";
}

// camera panel: centred at the bottom, mirrored (like a mirror) + aim and diagnostic indicators
function drawPanel() {
  const { x, y, w, h } = PANEL;
  const live = video.readyState >= 2;

  ctx.save();
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, 10); else ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.fillStyle = "#0B1017";
  ctx.fillRect(x, y, w, h);
  if (live) {
    ctx.save();
    ctx.translate(x + w, y);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, w, h);
    ctx.restore();
  } else {
    ctx.fillStyle = "#8C7BB5";
    ctx.font = "13px system-ui";
    ctx.textAlign = "center";
    ctx.fillText(game.input === "mouse" ? "mouse mode · no camera" : "camera not live yet", x + w / 2, y + h / 2);
    ctx.textAlign = "left";
  }
  ctx.restore();

  if (live) {
    const cx = x + w / 2;
    // the calibrated "centre"
    const centerPx = x + w * game.centerX;
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(centerPx, y + 4); ctx.lineTo(centerPx, y + h - 4); ctx.stroke();
    ctx.setLineDash([]);
    // position measured now + the lean bar
    const trackPx = x + w * Math.max(0, Math.min(1, game.trackX));
    ctx.strokeStyle = "rgba(242,193,78,0.9)";
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(centerPx, y + 14); ctx.lineTo(trackPx, y + 14); ctx.stroke();
    ctx.fillStyle = poseState.person ? "#7DE3F4" : "#93A1B3";
    ctx.beginPath(); ctx.arc(trackPx, y + 14, 4, 0, Math.PI * 2); ctx.fill();
    // threshold ticks: the lean bar must pass these to count as reaching
    const th = thresholds();
    const need = (game.arm.mode === "out" ? th.leanKeep : th.leanStart) * w;
    ctx.strokeStyle = "rgba(226,75,74,0.7)"; ctx.lineWidth = 1;
    for (const s of [-1, 1]) {
      ctx.beginPath(); ctx.moveTo(centerPx + s * need, y + 9); ctx.lineTo(centerPx + s * need, y + 19); ctx.stroke();
    }
  }

  ctx.strokeStyle = INK; ctx.lineWidth = 2;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  ctx.fillStyle = "#8C7BB5"; ctx.font = "12px system-ui";
  ctx.textAlign = "center";
  const cap = "Granny in the mirror — stays on your machine";
  const capW = ctx.measureText(cap).width + 20;
  ink(rectPts(x + w / 2 - capW / 2, y - 34, capW, 20), { fill: "rgba(255,244,220,0.95)", stroke: INK, lw: 2, seed: 305, amt: 1.6 });
  ctx.fillStyle = "#5C3A6B";
  ctx.fillText(cap, x + w / 2, y - 20);
  if (game.debug) {
    ctx.fillStyle = "#CDB4FF";
    ctx.fillText(game.debug, x + w / 2, y - 44);
  }
  ctx.textAlign = "left";
}

// crop to the centre at the target ratio so nothing is stretched
function drawCover(src, x, y, w, h) {
  const sw = src.width, sh = src.height;
  const target = w / h;
  let cw = sw, ch = sh;
  if (sw / sh > target) cw = sh * target;
  else ch = sw / target;
  ctx.drawImage(src, (sw - cw) / 2, (sh - ch) / 2, cw, ch, x, y, w, h);
}

// result screen: put the frame of the last catch in the middle
function drawResult() {
  const won = game.items.filter((i) => !isHazard(i.kind)).length === 0;
  ctx.fillStyle = "rgba(43,21,51,0.86)";
  ctx.fillRect(0, 0, W, H);

  ctx.textAlign = "center";
  ctx.fillStyle = won ? C.yellow : "#F6EFE6";
  ctx.font = "500 32px system-ui";
  ctx.fillText(won ? "All the jewellery is back!" : "Enough hunting for today", W / 2, 104);

  const pw = 440, ph = 330;
  const px = W / 2 - pw / 2, py = 126;

  ctx.save();
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(px, py, pw, ph, 12); else ctx.rect(px, py, pw, ph);
  ctx.clip();
  ctx.fillStyle = "#0B1017";
  ctx.fillRect(px, py, pw, ph);
  if (snap.canvas) {
    drawCover(snap.canvas, px, py, pw, ph);
    // darken the bottom so the caption below stays readable
    const g = ctx.createLinearGradient(0, py + ph * 0.5, 0, py + ph);
    g.addColorStop(0, "rgba(43,21,51,0)");
    g.addColorStop(1, "rgba(43,21,51,0.85)");
    ctx.fillStyle = g;
    ctx.fillRect(px, py + ph * 0.5, pw, ph * 0.5);
    ctx.fillStyle = "#FFF4DC";
    ctx.font = "500 18px system-ui";
    ctx.fillText(
      snap.label ? `The last thing she found: ${snap.label}` : "The moment she was hunting",
      W / 2, py + ph - 22
    );
  } else {
    ctx.fillStyle = "#8C7BB5";
    ctx.font = "14px system-ui";
    ctx.fillText("No camera frame this round (mouse mode)", W / 2, py + ph / 2);
  }
  ctx.restore();

  ctx.strokeStyle = won ? C.yellow : "#8C7BB5";
  ctx.lineWidth = 3;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(px, py, pw, ph, 12); else ctx.rect(px, py, pw, ph);
  ctx.stroke();

  ctx.textAlign = "center";
  ctx.fillStyle = "#FFF4DC";
  ctx.font = "600 20px system-ui";
  ctx.fillText(`Found ${game.score} ${game.score === 1 ? "piece" : "pieces"} of jewellery`, W / 2, py + ph + 40);
  ctx.font = "13px system-ui";
  ctx.fillStyle = "#CDB4FF";
  ctx.fillText("This round's frames stayed on your machine — nothing was uploaded", W / 2, py + ph + 62);
  ctx.textAlign = "left";

  // result-screen buttons are drawn inside the canvas too
  const n = snap.canvas ? 3 : 2;
  const bw = 152, gap = 16, by = py + ph + 80;
  let bx = W / 2 - (n * bw + (n - 1) * gap) / 2;
  uiButton(bx, by, bw, 46, "Look again", {
    fill: C.teal, fs: 17, seed: 851,
    action: () => { if (game.input === "none") game.input = "mouse"; reset(); },
  });
  bx += bw + gap;
  if (snap.canvas) {
    uiButton(bx, by, bw, 46, "Save this frame", { fill: C.yellow, fs: 17, seed: 852, action: saveSnap });
    bx += bw + gap;
  }
  uiButton(bx, by, bw, 46, "Home", {
    fill: "#FFF4DC", hot: C.yellow, text: "#241230", fs: 17, seed: 853, action: goHome,
  });
}

function saveSnap() {
  if (!snap.canvas) return;
  snap.canvas.toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "stretch-miner-last-catch.png";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  });
}

// ---------- Buttons inside the canvas ----------
function uiButton(x, y, w, h, label, o = {}) {
  const opt = {
    sub: "", fill: C.teal, hot: C.yellow, text: "#241230", hotText: "#241230",
    fs: 18, seed: 17, ...o,
  };
  const hot = inRect(ui.hover, x, y, w, h);
  pen = ctx;
  ink(rectPts(x + 5, y + 6, w, h), { fill: "rgba(43,21,51,0.3)", stroke: null, seed: opt.seed + 3, amt: 3 });
  ink(rectPts(x, y, w, h), {
    fill: hot ? opt.hot : opt.fill, stroke: INK, lw: 3.4, seed: opt.seed, amt: 3.2,
  });
  ctx.fillStyle = hot ? opt.hotText : opt.text;
  ctx.textAlign = "center";
  if (opt.sub) {
    ctx.font = `700 ${opt.fs}px system-ui`;
    ctx.fillText(label, x + w / 2, y + h / 2 - 1);
    ctx.font = "12.5px system-ui";
    ctx.globalAlpha = 0.8;
    ctx.fillText(opt.sub, x + w / 2, y + h / 2 + 17);
    ctx.globalAlpha = 1;
  } else {
    ctx.font = `700 ${opt.fs}px system-ui`;
    ctx.fillText(label, x + w / 2, y + h / 2 + opt.fs * 0.35);
  }
  ctx.textAlign = "left";
  ui.hits.push({ x, y, w, h });
  if (ui.click && inRect(ui.click, x, y, w, h)) {
    ui.click = null;
    if (opt.action) opt.action();
  }
}

// a spinning ball of yarn — the "head" of the progress bar
function drawYarnBall(cx, cy, r, t) {
  pen = ctx;
  disc(cx, cy, r, { fill: C.magenta, stroke: INK, lw: 3, seed: 620, amt: 1.8 });
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(t);
  ctx.strokeStyle = "rgba(255,244,220,0.85)";
  ctx.lineWidth = 2;
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 0.78, r * 0.34, (i * Math.PI) / 3, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
  // a short tail of yarn trailing the ball
  bar(cx - r - 16, cy + 3, cx - r + 2, cy - 2, INK, 2.4, 631, 1.6);
}

// ---------- Home screen (drawn inside the canvas) ----------
function drawHome() {
  ctx.fillStyle = "rgba(43,21,51,0.58)";
  ctx.fillRect(0, 0, W, H);
  pen = ctx;
  const cx = 150, cy = 56, cw = 660, ch = 528;
  ink(rectPts(cx + 9, cy + 11, cw, ch), { fill: "rgba(20,8,26,0.35)", stroke: null, seed: 911, amt: 3 });
  ink(rectPts(cx, cy, cw, ch), { fill: C.cream, stroke: INK, lw: 4.5, seed: 910, amt: 3.4 });

  ctx.textAlign = "center";
  ctx.fillStyle = INK;
  ctx.font = "700 38px system-ui";
  ctx.fillText("Find Granny's Jewellery", W / 2, cy + 76);
  ctx.font = "14.5px system-ui";
  ctx.fillStyle = "#5C3A6B";
  ctx.fillText("A short-sighted granny dropped her glasses and jewellery all over a messy desk", W / 2, cy + 106);
  ctx.textAlign = "left";

  // one piece of jewellery on each side of the title, as decoration
  drawItem({ kind: "glasses", r: 22, x: cx + 50, y: cy + 64, bob: 0.6 });
  drawItem({ kind: "necklace", r: 24, x: cx + cw - 50, y: cy + 64, bob: 2.1 });

  ctx.textAlign = "center";
  ctx.font = "14px system-ui";
  ctx.fillStyle = "#3D2647";
  ctx.fillText("How to play: shift your body (or head) left or right — her hand reaches that way.", W / 2, cy + 146);
  ctx.fillText("Hold the lean and it keeps growing; back to centre it snaps back.", W / 2, cy + 168);
  ctx.fillText("Touch a bug or a live plug: one shake, and one of your three tries is gone.", W / 2, cy + 190);
  ctx.textAlign = "left";

  const bw = 452, bx = W / 2 - bw / 2;
  uiButton(bx, cy + 208, bw, 64, "Start · no hands (shift your body)", {
    sub: "Recommended: play seated, no need to hold your arms up", fill: C.teal, seed: 921, action: () => startCamera("head"),
  });
  uiButton(bx, cy + 286, bw, 64, "Start · reach with your arm", {
    sub: "Raise one arm diagonally up and hold it", fill: C.magenta, hot: C.yellow,
    text: "#FFF4DC", hotText: "#241230", seed: 922, action: () => startCamera("arm"),
  });
  uiButton(bx, cy + 364, bw, 52, "Try with the mouse (no camera)", {
    fill: "#FFF4DC", hot: C.yellow, text: "#241230", fs: 16, seed: 923, action: startMouse,
  });

  ctx.textAlign = "center";
  ctx.font = "12.5px system-ui";
  ctx.fillStyle = "#5C3A6B";
  ctx.fillText("First run fetches ~15 MB of pose model — the bar proves it is not stuck. Later visits start in seconds.", W / 2, cy + 444);
  ctx.fillText("The camera feed is processed only on your own machine — never uploaded, never saved.", W / 2, cy + 466);
  ctx.textAlign = "left";
}

// ---------- Download progress (drawn inside the canvas) ----------
function drawLoading() {
  ctx.fillStyle = "rgba(43,21,51,0.74)";
  ctx.fillRect(0, 0, W, H);
  pen = ctx;
  const cx = 170, cy = 140, cw = 620, ch = 350;
  ink(rectPts(cx + 9, cy + 11, cw, ch), { fill: "rgba(20,8,26,0.35)", stroke: null, seed: 811, amt: 3 });
  ink(rectPts(cx, cy, cw, ch), { fill: C.cream, stroke: INK, lw: 4.5, seed: 810, amt: 3.4 });

  const t = performance.now() / 1000;
  const pct = loaderPct();

  ctx.textAlign = "center";
  ctx.fillStyle = INK;
  ctx.font = "700 26px system-ui";
  ctx.fillText("Borrowing a pair of eyes for Granny", W / 2, cy + 58);
  ctx.font = "13.5px system-ui";
  ctx.fillStyle = "#5C3A6B";
  ctx.fillText("About 15 MB the first run — play once the yarn below is wound; later visits start in seconds", W / 2, cy + 88);
  ctx.textAlign = "left";

  // percentage + bytes
  ctx.font = "700 34px system-ui";
  ctx.fillStyle = C.magenta;
  ctx.fillText(`${Math.round(pct * 100)}%`, cx + 42, cy + 146);
  ctx.textAlign = "right";
  ctx.font = "13.5px system-ui";
  ctx.fillStyle = "#5C3A6B";
  const doneB = Math.min(loader.total, loader.done + loader.fileDone);
  const speedTxt = loader.speed > 1024 ? ` · ${fmtBytes(loader.speed)}/s` : "";
  ctx.fillText(`${fmtBytes(doneB)} / ${fmtBytes(loader.total)}${speedTxt}`, cx + cw - 42, cy + 146);
  ctx.textAlign = "left";

  // the bar itself
  const bx = cx + 42, by = cy + 164, bw = cw - 84, bh = 32;
  ink(rectPts(bx, by, bw, bh), { fill: "#EFDFC0", stroke: INK, lw: 3.2, seed: 820, amt: 2.6 });
  const fw = (bw - 8) * pct;
  if (fw > 3) {
    ink(rectPts(bx + 4, by + 4, fw, bh - 8), { fill: C.teal, stroke: null, seed: 821, amt: 2.2 });
    // a few diagonal "yarn" stripes inside the fill
    for (let i = 0; i < Math.floor(fw / 22); i++) {
      const sx = bx + 10 + i * 22;
      bar(sx, by + bh - 6, sx + 9, by + 6, "rgba(255,255,255,0.35)", 3, 830 + i, 1.4);
    }
  }
  drawYarnBall(bx + 4 + fw, by + bh / 2, 16, t * 2.2);

  // which step is downloading
  ctx.textAlign = "center";
  ctx.font = "600 15px system-ui";
  ctx.fillStyle = INK;
  const stepTxt = loader.woke
    ? "Waking the model up… almost there"
    : `step ${Math.max(1, loader.step)}/${loader.steps} · ${loader.stage}` +
      (loader.fileTotal ? ` (${fmtBytes(loader.fileDone)} / ${fmtBytes(loader.fileTotal)})` : "");
  ctx.fillText(stepTxt, W / 2, by + bh + 34);
  ctx.font = "13px system-ui";
  ctx.fillStyle = "#5C3A6B";
  ctx.fillText(loader.speed || loader.woke ? "Not stuck — the yarn is still winding" : "Connecting…", W / 2, by + bh + 60);
  if (loader.err) {
    ctx.fillStyle = C.red;
    ctx.fillText(loader.err.slice(0, 60), W / 2, by + bh + 84);
  }
  ctx.textAlign = "left";

  uiButton(W / 2 - 80, cy + ch - 62, 160, 42, "Back to home", {
    fill: "#FFF4DC", hot: C.yellow, text: "#241230", fs: 15, seed: 840, action: goHome,
  });
}

// ---------- HUD inside the canvas ----------
function drawHud() {
  pen = ctx;
  const { x, y, w, h } = HUD_BAR;
  ink(rectPts(x, y, w, h), { fill: "rgba(255,244,220,0.95)", stroke: INK, lw: 3.4, seed: 700, amt: 2.8 });

  ctx.textAlign = "left";
  ctx.font = "700 18px system-ui";
  ctx.fillStyle = INK;
  ctx.fillText(`Found ${game.score}`, x + 18, y + 31);
  ctx.font = "13.5px system-ui";
  ctx.fillStyle = "#5C3A6B";
  ctx.fillText(`${game.items.filter((i) => !isHazard(i.kind)).length} left`, x + 108, y + 30);

  // three tries: three balls of yarn, one greys out per try used
  for (let i = 0; i < 3; i++) {
    disc(x + 216 + i * 28, y + 22, 9, {
      fill: i < game.lives ? C.magenta : "#C6B5D6", stroke: INK, lw: 2.4, seed: 720 + i, amt: 1.6,
    });
  }
  ctx.font = "12px system-ui";
  ctx.fillStyle = "#5C3A6B";
  ctx.fillText("tries", x + 216, y + 44);

  const modes = { head: "body", arm: "arm", mouse: "mouse" };
  ctx.font = "13.5px system-ui";
  ctx.fillText(`Mode: ${modes[game.input] || "-"}`, x + 320, y + 30);

  // sensitivity slider
  ctx.textAlign = "right";
  ctx.fillText("sensitivity", SENS_BAR.x - 12, y + 30);
  ctx.textAlign = "left";
  ctx.save();
  ink(rectPts(SENS_BAR.x, SENS_BAR.y, SENS_BAR.w, 9), { fill: "#E9D8B8", stroke: INK, lw: 2.4, seed: 760, amt: 1.8 });
  if (sens > 0.01) {
    ink(rectPts(SENS_BAR.x + 1, SENS_BAR.y + 1, (SENS_BAR.w - 2) * sens, 7), {
      fill: C.purple, stroke: null, seed: 761, amt: 1.6,
    });
  }
  disc(SENS_BAR.x + SENS_BAR.w * sens, SENS_BAR.y + 4, 9, {
    fill: C.yellow, stroke: INK, lw: 2.6, seed: 762, amt: 1.4,
  });
  ctx.restore();

  if (game.input === "head") {
    uiButton(BTN_CAL.x, BTN_CAL.y, BTN_CAL.w, BTN_CAL.h, "Centre here", {
      fill: "#FFF4DC", hot: C.yellow, text: "#241230", fs: 13, seed: 770,
      action: () => {
        game.centerX = game.trackX;
        setStatus(`Set ${(game.centerX * 100).toFixed(0)}% as the centre — now lean left or right to reach`);
      },
    });
  }
  uiButton(BTN_HOME.x, BTN_HOME.y, BTN_HOME.w, BTN_HOME.h, "Home", {
    fill: "#FFF4DC", hot: C.yellow, text: "#241230", fs: 13, seed: 780, action: goHome,
  });
}

function drawOverlay() {
  if (game.flash > 0) {
    ctx.fillStyle = `rgba(${game.flashColor},${Math.min(0.62, game.flash * 0.72)})`;
    ctx.fillRect(0, 0, W, H);
  }
}

function draw(dt) {
  if (!deskLayer) buildDesk();
  ctx.save();
  if (game.shake > 0) {
    const s = game.shake;
    ctx.translate(
      W / 2 + (Math.random() - 0.5) * 34 * s,
      H / 2 + (Math.random() - 0.5) * 34 * s
    );
    ctx.rotate((Math.random() - 0.5) * 0.035 * s);
    ctx.translate(-W / 2, -H / 2);
  }
  ctx.drawImage(deskLayer, 0, 0);
  pen = ctx;
  if (game.phase === "playing" || game.phase === "over") {
    for (const it of game.items) drawItem(it);
    drawArm();
    if (game.arm.carry) {
      const tip = tipPos();
      drawItem({ ...game.arm.carry, x: tip.x, y: tip.y + 18, bob: 0 });
    }
    drawPops();
  }
  ctx.restore();
  pen = ctx;

  if (game.phase === "home") drawHome();
  else if (game.phase === "loading") drawLoading();
  else if (game.phase === "playing") {
    drawHud();
    drawStatusLine();
    drawPanel();
    drawGranny();
  }
  if (game.phase === "over") drawResult();
  drawOverlay();

  const overBtn = ui.hits.some((b) => inRect(ui.hover, b.x, b.y, b.w, b.h));
  canvas.style.cursor = overBtn ? "pointer" : "default";
}

// ---------- Detection rate (only for the in-canvas debug line) ----------
let fpsT0 = 0;
setInterval(() => {
  const now = performance.now();
  const secs = (now - fpsT0) / 1000;
  if (fpsT0 && secs > 0.5) {
    poseState.fps = Math.round(poseState.detects / secs);
    poseState.detects = 0;
    fpsT0 = now;
  } else if (!fpsT0) fpsT0 = now;
}, 500);

// ---------- Main loop ----------
function loop(ts) {
  const dt = Math.min((ts - (game.lastTs || ts)) / 1000, 0.05);
  game.lastTs = ts;
  poseState.live = video.readyState >= 2; // refreshed in every mode
  ui.hits = [];                            // buttons are registered again every frame

  let input = { holding: false, dir: null };
  if (game.input === "head" || game.input === "arm") {
    const r = game.phase === "playing" ? readPose(ts) : null;
    if (r) {
      input = r;
    } else if (performance.now() - poseState.lastOk < HOLD_MS) {
      input = lastInput; // same video frame / momentary dropout: reuse the last result, don't read it as letting go
    } else {
      input = { holding: false, dir: lastInput.dir };
      if (game.phase === "playing") {
        if (!poseState.live) setStatus("No camera picture yet — wait a moment, or press Home and start again");
        else if (!poseState.person) setStatus("Nobody in view — step into frame with your upper body visible");
      }
    }
  } else {
    input = game.phase === "playing" ? mouseInput() : { holding: false, dir: null };
  }

  updateArm(dt, input.holding, input.dir);

  if (game.flash > 0) game.flash = Math.max(0, game.flash - dt * 1.2);
  if (game.shake > 0) game.shake = Math.max(0, game.shake - dt * 1.1); // shake a little longer: a hit should startle
  if (game.pops) game.pops = game.pops.filter((p) => (p.t += dt) < 1.1);

  draw(dt);
  ui.click = null;   // a click counts only for this frame: if it hit nothing, drop it so it can't trigger a later button
  requestAnimationFrame(loop);
}

// keyboard works too: Enter or Space on home/result, Esc during play returns home
window.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " " && e.key !== "Escape") return;
  if (game.phase === "home" && e.key !== "Escape") {
    e.preventDefault();
    startCamera("head");
  } else if (game.phase === "over" && e.key !== "Escape") {
    e.preventDefault();
    if (game.input === "none") game.input = "mouse";
    reset();
  } else if (e.key === "Escape" && game.phase !== "home") {
    goHome();
  }
});

syncHud();
requestAnimationFrame(loop);

// for debugging: inspect __stretchMiner.game / .poseState in the console
window.__stretchMiner = {
  game, poseState, snap, loader, ui,
  reset, startMouse, startCamera, goHome, readHead, readArm,
  get sens() { return sens; }, set sens(v) { sens = v; },   // for debugging
  loadPose, // exposed for offline self-checks: await __stretchMiner.loadPose() should return a model instance
  // inject a fake pose detector (offline self-checks only, not needed at runtime)
  _injectDetector(fn) {
    poseLandmarker = { detectForVideo: fn };
    poseState.model = true;
    return true;
  },
};
