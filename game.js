// Stretch Miner — 拉伸版黄金矿工
// 摄像头画面实时显示在画布底部正中（镜像，像照镜子）
// 三种控制：head（身体/头部左右偏移，不用手）· arm（伸手臂）· mouse（鼠标，降级用）
// 画面全部在本地处理，不上传、不保存。

// 库和模型优先用仓库里的本地副本（与页面同源，别人打开也不需要访问 jsdelivr / Google）；
// 本地取不到时再退回在线源。两套来源的库与 wasm 必须配对，不能混版本。
const SOURCES = [
  { name: "本地", lib: "./vendor/vision_bundle.mjs", wasm: "./vendor/wasm" },
  {
    name: "CDN",
    lib: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs",
    wasm: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm",
  },
];
const MODEL_URLS = [
  "./vendor/models/pose_landmarker_lite.task",
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task",
];

const canvas = document.getElementById("stage");
const ctx = canvas.getContext("2d");
const W = canvas.width;
const H = canvas.height;
const video = document.getElementById("cam");

const el = {
  score: document.getElementById("score"),
  left: document.getElementById("left"),
  lives: document.getElementById("lives"),
  status: document.getElementById("status"),
  diag: document.getElementById("diag"),
  sens: document.getElementById("sens"),
  sensVal: document.getElementById("sensVal"),
  save: document.getElementById("btnSave"),
};

// 摄像头画面：画布底部正中
const PANEL = { w: 300, h: 225, x: W / 2 - 150, y: H - 225 - 14 };
// 手臂从这个画面的顶边正中伸出去
const ANCHOR = { x: W / 2, y: PANEL.y };
const STRETCH_SPEED = 430;   // 伸长速度 px/s
const RETRACT_SPEED = 1500;  // 收回速度 px/s（"极速"）
const MAX_REACH = 780;
const TIP_R = 14;
const MIN_TILT = 0.10;       // 刚越过阈值时的偏角（约 6°，几乎正上方）
const MAX_TILT = 1.15;       // 偏到底时的偏角（约 66°）

const TREASURE_PLAN = ["diamond", "gold", "bag", "gold", "diamond", "bag", "gold"];
const BOMB_COUNT = 3;

// 灵敏度：0 = 最迟钝，1 = 最灵敏（滑块实时可调，不用改代码）
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
  phase: "ready",        // ready | playing | over
  input: "none",         // head | arm | mouse
  score: 0,
  lives: 3,
  items: [],
  arm: { len: 0, dir: { x: 0, y: -1 }, mode: "idle", carry: null, lock: false },
  flash: 0,
  shake: 0,
  lastTs: 0,
  seenPerson: false,
  debug: "",
  lean: 0,          // 当前偏移（正=画面右侧）
  centerX: 0.5,     // 校准后的"中间"位置
  trackX: 0.5,      // 实时测到的身体横向位置
  armInfo: "",
};

// 摄像头链路的实时状态，全部显示在诊断面板上
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

// ---------- 定格帧：抓到宝物那一刻的摄像头画面 ----------
// 每次抓到宝物都覆盖一次，所以局末留下的就是"抓住最后一个"的那一帧。
// 只存在内存里的 canvas，不上传、不落盘（除非你主动点「保存这一帧」）。
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
  c.translate(snap.canvas.width, 0); // 镜像存下来，显示时和镜中的你一致
  c.scale(-1, 1);
  c.drawImage(video, 0, 0);
  c.restore();
  snap.label = label;
  snap.ms = performance.now();
  return snap.canvas;
}

// ---------- 音效（Web Audio，无外部资源） ----------
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
const sfxBomb = () => beep([150, 90], "sawtooth", 0.22);
const sfxMiss = () => beep([220], "sine", 0.08);
const sfxWin = () => beep([523, 659, 784, 1047], "triangle", 0.14);

// ---------- 宝物布局 ----------
const KIND = {
  diamond: { r: 17, label: "钻石" },
  gold: { r: 20, label: "金块" },
  bag: { r: 22, label: "钱袋" },
};

function place(items, kind, r, minGap, tries = 200) {
  for (let t = 0; t < tries; t++) {
    const p = {
      x: 70 + Math.random() * (W - 140),
      y: 64 + Math.random() * 266,
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
  for (let i = 0; i < BOMB_COUNT; i++) place(game.items, "bomb", 20, 88);
}

function reset() {
  game.phase = "playing";
  game.score = 0;
  game.lives = 3;
  game.arm = { len: 0, dir: { x: 0, y: -1 }, mode: "idle", carry: null, lock: false };
  game.flash = 0;
  game.shake = 0;
  game.debug = "";
  game.lean = 0;
  snap.canvas = null;   // 上一局的定格帧不留下
  snap.label = "";
  el.save.hidden = true;
  layout();
  syncHud();
  if (game.input === "head") setStatus("准备好了 —— 身体往左/右挪一点，手臂就朝那边伸");
  else if (game.input === "arm") setStatus("准备好了 —— 向斜上方伸出一只手臂并保持住");
  else setStatus("按住鼠标，朝斜上方拖动");
}

// ---------- HUD ----------
function syncHud() {
  el.score.textContent = String(game.score);
  el.left.textContent = String(game.items.filter((i) => i.kind !== "bomb").length);
  el.lives.innerHTML = "";
  for (let i = 0; i < 3; i++) {
    const d = document.createElement("span");
    d.className = "life" + (i < game.lives ? "" : " gone");
    el.lives.appendChild(d);
  }
}
function setStatus(text) {
  el.status.textContent = text;
}

// ---------- 手臂状态机 ----------
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
  return game.input === "head" ? "先回到画面中间，再往左/右挪" : "先放下手臂，再伸一次";
}

function startRetract(reason) {
  game.arm.mode = "back";
  // 注意：这里故意不上"必须松开才能再伸"的锁 —— 只要人还保持偏移，
  // 收回到底后就自动再伸一次，否则会出现"明明举着手却毫无反应"的假死。
  if (reason === "miss") {
    setStatus("够不着 —— 手臂弹回，" + relaxHint());
    sfxMiss();
  } else if (reason === "release") {
    setStatus("松开了 —— 极速收回");
  }
}

function updateArm(dt, holding, dir) {
  const arm = game.arm;
  if (dir) arm.dir = dir;

  if (game.phase !== "playing") return;

  if (arm.mode === "idle" || arm.mode === "out") {
    if (holding) {
      if (arm.mode !== "out") game.bombMsg = null;
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
        setStatus(`抓到${KIND[arm.carry.kind].label}！+1 分`);
        arm.carry = null;
        syncHud();
        if (game.items.filter((i) => i.kind !== "bomb").length === 0) finish(true);
      } else if (game.phase === "playing") {
        if (game.bombMsg) setStatus(game.bombMsg);
        else if (game.input === "head") setStatus("往左或往右再挪一点 —— 手臂就朝那边伸");
        else if (game.input === "arm") setStatus("再伸一次 —— 举高一点更容易够到");
        else setStatus("按住鼠标再试一次");
      }
    }
  }

  // 碰撞检测
  if (arm.mode === "out") {
    const tip = tipPos();
    for (const it of game.items) {
      if (Math.hypot(it.x - tip.x, it.y - tip.y) < it.r + TIP_R) {
        game.items.splice(game.items.indexOf(it), 1);
        if (it.kind === "bomb") {
          game.lives -= 1;
          game.flash = 0.35;
          game.shake = 0.3;
          arm.mode = "back";
          sfxBomb();
          setStatus(`炸弹！剩余 ${Math.max(game.lives, 0)} 条命`);
          if (game.lives > 0) game.bombMsg = `炸弹！剩余 ${game.lives} 条命 —— ${relaxHint()}`;
          syncHud();
          if (game.lives <= 0) finish(false);
        } else {
          arm.carry = it;
          arm.mode = "back";
          sfxGrab();
          snapCamera(KIND[it.kind].label); // 定格这一刻（最后一次覆盖后就是"最后一个"）
          setStatus(`抓住了${KIND[it.kind].label} —— 收回来`);
        }
        break;
      }
    }
  }
}

function finish(won) {
  game.phase = "over";
  game.arm.mode = "back";
  // 一个宝物都没抓到就结束（比如三条命都撞炸弹）：至少留一帧当下的画面
  if (!snap.canvas) snapCamera("");
  el.save.hidden = !snap.canvas;
  syncHud();
  if (won) {
    setStatus(`全部收完！得分 ${game.score} —— 点「重来一局」`);
    sfxWin();
  } else {
    setStatus("三条命用完了 —— 点「重来一局」");
    beep([330, 220, 160], "sawtooth", 0.2);
  }
}

// ---------- 摄像头 / 姿态 ----------
let poseLandmarker = null;
let lastVideoTime = -1;
let lastInput = { holding: false, dir: null };   // 上一帧的有效结果（防抖用）
const HOLD_MS = 400;                              // 丢失检测后维持上一结果的时间

async function loadPose() {
  if (poseLandmarker) return poseLandmarker;
  let lastErr = null;

  for (const src of SOURCES) {
    let lib;
    try {
      setStatus(`正在加载姿态库（${src.name}）…`);
      lib = await import(/* @vite-ignore */ src.lib);
    } catch (err) {
      lastErr = err;
      continue;
    }
    let fileset;
    try {
      fileset = await lib.FilesetResolver.forVisionTasks(src.wasm);
    } catch (err) {
      lastErr = err;
      continue;
    }
    const build = (delegate, url) => ({
      baseOptions: { modelAssetPath: url, delegate },
      runningMode: "VIDEO",
      numPoses: 1,
      minPoseDetectionConfidence: 0.4,
      minPosePresenceConfidence: 0.4,
      minTrackingConfidence: 0.4,
    });
    for (const url of MODEL_URLS) {
      setStatus(`正在下载姿态模型（${src.name}）…`);
      for (const delegate of ["GPU", "CPU"]) {
        try {
          poseLandmarker = await lib.PoseLandmarker.createFromOptions(fileset, build(delegate, url));
          poseState.model = true;
          poseState.delegate = delegate;
          poseState.lib = src.name;
          poseState.modelUrl = `${src.name}·${url.includes("lite") ? "lite" : "full"}`;
          return poseLandmarker;
        } catch (err) {
          lastErr = err;
          poseLandmarker = null;
        }
      }
    }
  }
  poseState.err = String(lastErr || "unknown");
  throw lastErr || new Error("pose model failed");
}

async function startCamera(mode = "head") {
  if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
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
    setStatus("摄像头不可用或被拒绝 —— 已切到鼠标模式");
    startMouse();
    return;
  }
  try {
    await loadPose();
  } catch (err) {
    setStatus("姿态模型加载失败 —— 已切到鼠标模式（看下方诊断）");
    startMouse();
    return;
  }
  game.input = mode;
  reset();
}

function startMouse() {
  if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
  game.input = "mouse";
  reset();
}

// 归一化坐标 -> 镜像后取点（画面像镜子一样）
const mirror = (p) => ({ x: 1 - p.x, y: p.y });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function readPose(ts) {
  poseState.live = video.readyState >= 2;
  if (!poseLandmarker) return null;
  if (video.readyState < 2) return null;
  // 同一视频帧不重复推理；这里返回 null 由调用方复用上一次结果，
  // 千万不要把它当成"人松手了"（那是原来手臂永久锁死的 bug）
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

// 不用手：看身体中线（肩中点为主，鼻子可信时加权）偏离"中间"多少
// 往哪边挪，手臂就往那个斜上方伸；挪回中间就极速收回
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

  const lean = Math.max(-0.5, Math.min(0.5, raw - game.centerX)); // 正=往画面右边
  game.lean = lean;

  const th = thresholds();
  const out = game.arm.mode === "out";
  const need = out ? th.leanKeep : th.leanStart;
  const holding = Math.abs(lean) > need;

  // 越过阈值后从"正上方"开始扫，偏得越多越往两边 —— 这样正中央的宝物也够得到
  // dead 固定用 leanStart（不是迟滞后的 need），否则触发那一刻方向会突跳
  const dead = th.leanStart;
  const over = Math.max(0, Math.abs(lean) - dead);
  const span = Math.max(0.06, 0.45 - dead);
  const t = Math.min(1, over / span);
  const tilt = Math.sign(lean) * (MIN_TILT + t * (MAX_TILT - MIN_TILT));
  const dir = { x: Math.sin(tilt), y: -Math.cos(tilt) };

  game.debug = `偏移 ${lean > 0 ? "右" : "左"} ${Math.abs(lean * 100).toFixed(0)}%（阈值 ${(need * 100).toFixed(0)}%）· ${holding ? "伸长中" : "收回"}`;
  return { holding, dir };
}

// 伸手臂控制：选伸得更靠上的那只手，用它的方向当手臂方向
function readArm(lm) {
  const ls = mirror(lm[11]), rs = mirror(lm[12]);
  const lw = mirror(lm[15]), rw = mirror(lm[16]);
  const lh = mirror(lm[23]), rh = mirror(lm[24]);
  const shMid = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };
  const hipMid = { x: (lh.x + rh.x) / 2, y: (lh.y + rh.y) / 2 };
  const U = Math.max(dist(shMid, hipMid), 0.08); // 躯干长度作单位
  const aspect = (video.videoWidth || 4) / (video.videoHeight || 3);

  let best = null;
  for (const [s, w] of [[ls, lw], [rs, rw]]) {
    const v = { x: (w.x - s.x) * aspect, y: w.y - s.y };
    const len = Math.hypot(v.x, v.y) / U;
    const up = -v.y / U; // 向上为正
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
    if (dy > -0.18) dy = -0.18; // 只允许指向上方两个象限
    const mm = Math.hypot(dx, dy);
    dir = { x: dx / mm, y: dy / mm };
  }
  game.armInfo = `臂长 ${best.len.toFixed(2)}/${needLen.toFixed(2)} · 上扬 ${best.up.toFixed(2)}/${needUp.toFixed(2)}`;
  game.debug = game.armInfo + ` · ${holding ? "伸出" : "收回"}`;
  return { holding, dir };
}

// ---------- 鼠标模式 ----------
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

canvas.addEventListener("pointerdown", (e) => {
  if (game.input !== "mouse") return;
  mouse.active = true;
  setPointer(e);
  try { canvas.setPointerCapture(e.pointerId); } catch { /* 合成事件或不支持时忽略 */ }
});
canvas.addEventListener("pointermove", (e) => {
  if (game.input === "mouse") setPointer(e);
});
window.addEventListener("pointerup", () => { mouse.active = false; });
function setPointer(e) {
  const r = canvas.getBoundingClientRect();
  mouse.x = ((e.clientX - r.left) / r.width) * W;
  mouse.y = ((e.clientY - r.top) / r.height) * H;
}

// ---------- 绘制 ----------
function drawBackground() {
  ctx.fillStyle = "#101720";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#16202C";
  ctx.beginPath();
  ctx.ellipse(W / 2, -60, W * 0.62, 220, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#1B2531";
  ctx.beginPath();
  ctx.moveTo(0, H);
  ctx.lineTo(0, H - 74);
  ctx.quadraticCurveTo(W * 0.35, H - 108, W * 0.62, H - 80);
  ctx.quadraticCurveTo(W * 0.85, H - 60, W, H - 92);
  ctx.lineTo(W, H);
  ctx.closePath();
  ctx.fill();
}

function drawItem(it) {
  const bobY = it.y + Math.sin(performance.now() / 700 + it.bob) * 3;
  ctx.save();
  ctx.translate(it.x, bobY);
  if (it.kind === "diamond") {
    ctx.fillStyle = "#7DE3F4";
    ctx.beginPath();
    ctx.moveTo(0, -it.r); ctx.lineTo(it.r * 0.8, 0); ctx.lineTo(0, it.r); ctx.lineTo(-it.r * 0.8, 0);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = "#D7F6FD"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(-it.r * 0.8, 0); ctx.lineTo(it.r * 0.8, 0); ctx.stroke();
  } else if (it.kind === "gold") {
    ctx.fillStyle = "#F2C14E";
    ctx.beginPath();
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      const rr = it.r * (0.82 + 0.2 * Math.sin(i * 2.1));
      ctx[i ? "lineTo" : "moveTo"](Math.cos(a) * rr, Math.sin(a) * rr);
    }
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#FFF3CF";
    ctx.beginPath(); ctx.arc(-4, -5, 4, 0, Math.PI * 2); ctx.fill();
  } else if (it.kind === "bag") {
    ctx.fillStyle = "#C98C4B";
    ctx.beginPath();
    ctx.ellipse(0, 3, it.r * 0.85, it.r, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#8E5C2C";
    ctx.fillRect(-it.r * 0.42, -it.r - 5, it.r * 0.84, 9);
    ctx.fillStyle = "#F2C14E";
    ctx.beginPath(); ctx.arc(0, 2, 5, 0, Math.PI * 2); ctx.fill();
  } else {
    ctx.fillStyle = "#2E3742";
    ctx.beginPath(); ctx.arc(0, 0, it.r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#5A6878"; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(0, -it.r); ctx.quadraticCurveTo(10, -it.r - 12, 18, -it.r - 6); ctx.stroke();
    ctx.fillStyle = "#F28C3B";
    ctx.beginPath(); ctx.arc(19, -it.r - 7, 3.5, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

function drawMiner() {
  // 用摄像头画面本身当"人"，这里只画一顶矿工帽压在画面顶边
  const { x, y } = ANCHOR;
  ctx.fillStyle = "#F2C14E";
  ctx.beginPath();
  ctx.ellipse(x, y + 4, 26, 9, 0, Math.PI, 0);
  ctx.fill();
  ctx.fillRect(x - 26, y + 3, 52, 5);
  ctx.fillStyle = "#E8EDF4";
  ctx.beginPath(); ctx.arc(x, y - 2, 5, 0, Math.PI * 2); ctx.fill();
}

function drawArm() {
  const arm = game.arm;
  const tip = tipPos();
  const midX = ANCHOR.x + arm.dir.x * arm.len * 0.45;
  const midY = ANCHOR.y + arm.dir.y * arm.len * 0.45;
  ctx.lineCap = "round";
  ctx.strokeStyle = "#3E6B8C"; ctx.lineWidth = 20;
  ctx.beginPath(); ctx.moveTo(ANCHOR.x, ANCHOR.y - 4); ctx.lineTo(midX, midY); ctx.stroke();
  ctx.strokeStyle = "#E8B98A"; ctx.lineWidth = 14;
  ctx.beginPath(); ctx.moveTo(midX, midY); ctx.lineTo(tip.x, tip.y); ctx.stroke();

  const ang = Math.atan2(arm.dir.y, arm.dir.x);
  const spread = arm.carry ? 0.12 : 0.5;
  ctx.strokeStyle = "#D9A05B"; ctx.lineWidth = 5;
  for (const s of [-1, 1]) {
    const a = ang + s * spread;
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(tip.x + Math.cos(a) * 24, tip.y + Math.sin(a) * 24);
    ctx.stroke();
  }
}

// 摄像头画面：底部正中，镜像显示（像照镜子）+ 瞄准/诊断指示
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
    ctx.fillStyle = "#4A5766";
    ctx.font = "13px system-ui";
    ctx.textAlign = "center";
    ctx.fillText(game.input === "mouse" ? "鼠标模式 · 没用摄像头" : "摄像头未开启", x + w / 2, y + h / 2);
    ctx.textAlign = "left";
  }
  ctx.restore();

  if (live) {
    const cx = x + w / 2;
    // 校准的"中间"位置
    const centerPx = x + w * game.centerX;
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(centerPx, y + 4); ctx.lineTo(centerPx, y + h - 4); ctx.stroke();
    ctx.setLineDash([]);
    // 当前测得位置 + 偏移条
    const trackPx = x + w * Math.max(0, Math.min(1, game.trackX));
    ctx.strokeStyle = "rgba(242,193,78,0.9)";
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(centerPx, y + 14); ctx.lineTo(trackPx, y + 14); ctx.stroke();
    ctx.fillStyle = poseState.person ? "#7DE3F4" : "#93A1B3";
    ctx.beginPath(); ctx.arc(trackPx, y + 14, 4, 0, Math.PI * 2); ctx.fill();
    // 阈值刻度：偏移条要超出这两条才算"伸"
    const th = thresholds();
    const need = (game.arm.mode === "out" ? th.leanKeep : th.leanStart) * w;
    ctx.strokeStyle = "rgba(226,75,74,0.7)"; ctx.lineWidth = 1;
    for (const s of [-1, 1]) {
      ctx.beginPath(); ctx.moveTo(centerPx + s * need, y + 9); ctx.lineTo(centerPx + s * need, y + 19); ctx.stroke();
    }
  }

  ctx.strokeStyle = "#2A3543"; ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  ctx.fillStyle = "#6C7C90"; ctx.font = "11px system-ui";
  ctx.textAlign = "center";
  ctx.fillText("你在这一格 · 画面只在本地，不上传", x + w / 2, y - 7);
  if (game.debug) ctx.fillText(game.debug, x + w / 2, y + h + 15);
  ctx.textAlign = "left";
}

// 按目标比例裁中间，避免拉伸变形
function drawCover(src, x, y, w, h) {
  const sw = src.width, sh = src.height;
  const target = w / h;
  let cw = sw, ch = sh;
  if (sw / sh > target) cw = sh * target;
  else ch = sw / target;
  ctx.drawImage(src, (sw - cw) / 2, (sh - ch) / 2, cw, ch, x, y, w, h);
}

// 结算画面：把"抓住最后一个"那一帧放到正中
function drawResult() {
  const won = game.items.filter((i) => i.kind !== "bomb").length === 0;
  ctx.fillStyle = "rgba(10,14,20,0.82)";
  ctx.fillRect(0, 0, W, H);

  ctx.textAlign = "center";
  ctx.fillStyle = won ? "#F2C14E" : "#E8EDF4";
  ctx.font = "500 30px system-ui";
  ctx.fillText(won ? "全部收完" : "游戏结束", W / 2, 104);

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
    // 底部压一层暗，让下面的字看得清
    const g = ctx.createLinearGradient(0, py + ph * 0.55, 0, py + ph);
    g.addColorStop(0, "rgba(10,14,20,0)");
    g.addColorStop(1, "rgba(10,14,20,0.78)");
    ctx.fillStyle = g;
    ctx.fillRect(px, py + ph * 0.55, pw, ph * 0.45);
    ctx.fillStyle = "#E8EDF4";
    ctx.font = "500 17px system-ui";
    ctx.fillText(
      snap.label ? `抓到最后一个：${snap.label}` : "抓到最后一个的那一刻",
      W / 2, py + ph - 22
    );
  } else {
    ctx.fillStyle = "#4A5766";
    ctx.font = "14px system-ui";
    ctx.fillText("这一局没有摄像头画面（鼠标模式）", W / 2, py + ph / 2);
  }
  ctx.restore();

  ctx.strokeStyle = won ? "#F2C14E" : "#41556B";
  ctx.lineWidth = 2;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(px, py, pw, ph, 12); else ctx.rect(px, py, pw, ph);
  ctx.stroke();

  ctx.fillStyle = "#E8EDF4";
  ctx.font = "500 20px system-ui";
  ctx.fillText(`得分 ${game.score}`, W / 2, py + ph + 44);
  ctx.font = "14px system-ui";
  ctx.fillStyle = "#93A1B3";
  ctx.fillText(
    snap.canvas ? "点「保存这一帧」存成 PNG · 点「重来一局」再来" : "点上方「重来一局」再来一次",
    W / 2, py + ph + 76
  );
  ctx.textAlign = "left";
}

function drawOverlay() {
  if (game.flash > 0) {
    ctx.fillStyle = `rgba(226,75,74,${game.flash * 0.5})`;
    ctx.fillRect(0, 0, W, H);
  }
  if (game.phase === "over") {
    drawResult();
  } else if (game.phase === "ready") {
    ctx.fillStyle = "rgba(10,14,20,0.6)";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#E8EDF4";
    ctx.font = "500 22px system-ui";
    ctx.textAlign = "center";
    ctx.fillText("点「开始」", W / 2, H / 2);
    ctx.textAlign = "left";
  }
}

function draw(dt) {
  ctx.save();
  if (game.shake > 0) {
    ctx.translate((Math.random() - 0.5) * 10 * game.shake, (Math.random() - 0.5) * 10 * game.shake);
  }
  drawBackground();
  for (const it of game.items) drawItem(it);
  drawArm();
  if (game.arm.carry) {
    const tip = tipPos();
    drawItem({ ...game.arm.carry, x: tip.x, y: tip.y + 18, bob: 0 });
  }
  ctx.restore();
  drawPanel();
  drawMiner();
  drawOverlay();
}

// ---------- 诊断面板 ----------
let fpsT0 = 0, fpsN = 0;
function updateDiag() {
  const now = performance.now();
  if (!fpsT0) fpsT0 = now;
  const secs = (now - fpsT0) / 1000;
  if (secs > 0.5) {
    poseState.fps = Math.round(poseState.detects / secs);
    poseState.detects = 0;
    fpsT0 = now;
  }
  const ok = (v) => (v ? "✓" : "✗");
  el.diag.innerHTML =
    `摄像头 ${ok(poseState.live)} · 模型 ${ok(poseState.model)}（${poseState.modelUrl}/${poseState.delegate}）` +
    ` · 检测到人 ${ok(poseState.person)} · 检测 ${poseState.fps} 次/秒` +
    ` · 身体位置 ${(game.trackX * 100).toFixed(0)}% · 中线 ${(game.centerX * 100).toFixed(0)}%` +
    ` · 偏移 ${(game.lean * 100).toFixed(0)}%` +
    (poseState.err ? ` · <span class="warn">${poseState.err}</span>` : "");
}

// ---------- 主循环 ----------
function loop(ts) {
  const dt = Math.min((ts - (game.lastTs || ts)) / 1000, 0.05);
  game.lastTs = ts;
  poseState.live = video.readyState >= 2; // 任何模式下都刷新，别让诊断行停在旧状态

  let input;
  if (game.input === "head" || game.input === "arm") {
    const r = readPose(ts);
    if (r) {
      input = r;
    } else if (performance.now() - poseState.lastOk < HOLD_MS) {
      input = lastInput; // 同一视频帧 / 瞬间丢帧：沿用上一次，不要误判成松手
    } else {
      input = { holding: false, dir: lastInput.dir };
      if (game.phase === "playing") {
        if (!poseState.live) setStatus("摄像头还没画面 —— 等一下，或点「重来一局」");
        else if (!poseState.model) setStatus("姿态模型还没加载完 —— 看下方诊断");
        else if (!poseState.person) setStatus("看不到人 —— 站进镜头，让上半身进画面");
      }
    }
  } else {
    input = mouseInput();
  }

  updateArm(dt, input.holding, input.dir);

  if (game.flash > 0) game.flash = Math.max(0, game.flash - dt);
  if (game.shake > 0) game.shake = Math.max(0, game.shake - dt * 2);

  draw(dt);
  updateDiag();
  requestAnimationFrame(loop);
}

document.getElementById("btnHead").addEventListener("click", () => startCamera("head"));
document.getElementById("btnArm").addEventListener("click", () => startCamera("arm"));
document.getElementById("btnMouse").addEventListener("click", startMouse);
document.getElementById("btnRestart").addEventListener("click", () => {
  if (game.input === "none") game.input = "mouse";
  reset();
});
el.save.addEventListener("click", () => {
  if (!snap.canvas) return;
  snap.canvas.toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "stretch-miner-last-catch.png";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  });
});
document.getElementById("btnCenter").addEventListener("click", () => {
  game.centerX = game.trackX;
  setStatus(`已把 ${(game.centerX * 100).toFixed(0)}% 设为"中间" —— 现在往左/右挪就能伸`);
});
el.sens.addEventListener("input", () => {
  sens = Number(el.sens.value) / 100;
  el.sensVal.textContent = String(el.sens.value);
});

syncHud();
requestAnimationFrame(loop);

// 调试用：控制台里可以 __stretchMiner.game / .poseState 看状态
window.__stretchMiner = {
  game, poseState, snap, reset, startMouse, startCamera, readHead, readArm,
  loadPose, // 暴露出来便于离线自检：await __stretchMiner.loadPose() 应返回模型实例
  // 注入一个假的姿态检测器（离线自检用，正常运行时不需要）
  _injectDetector(fn) {
    poseLandmarker = { detectForVideo: fn };
    poseState.model = true;
    return true;
  },
};
