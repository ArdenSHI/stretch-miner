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

// 摄像头画面：画布底部正中 —— 奶奶的脸就在这格里
const PANEL = { w: 300, h: 225, x: W / 2 - 150, y: H - 225 - 14 };
// 手臂从这个画面的顶边正中伸出去
const ANCHOR = { x: W / 2, y: PANEL.y };
const STRETCH_SPEED = 430;   // 伸长速度 px/s
const RETRACT_SPEED = 1500;  // 收回速度 px/s（"极速"）
const MAX_REACH = 780;
const TIP_R = 14;
const MIN_TILT = 0.10;       // 刚越过阈值时的偏角（约 6°，几乎正上方）
const MAX_TILT = 1.15;       // 偏到底时的偏角（约 66°）

// ---------- 画风：马克笔笔触 + 高饱和配色 ----------
const INK = "#2B1533";
const C = {
  teal: "#00B8A9", magenta: "#FF3D7F", orange: "#FF8A3D", yellow: "#FFD23F",
  purple: "#8A4FFF", red: "#E5322D", blue: "#1E7BE8", green: "#4FD14F",
  pink: "#FF9BC6", cream: "#FFF4DC", wood: "#E08A2B", woodDark: "#B45F1C",
  gold: "#F2B705", lilac: "#CDB4FF", skin: "#F6C9A0", skinShade: "#E0A277",
};

// 所有笔触都走 pen（默认主画布）；画静态桌面时临时切到离屏画布
let pen = ctx;

// 确定性抖动：同一件东西每一帧抖得一模一样，画面才不会闪
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
// 一遍填充 + 两遍描边：故意让颜色溢出轮廓，像笔没涂在线里
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

// ---------- 桌面上的东西 ----------
// 奶奶要找的：眼镜、项链、耳环、戒指、胸针、发夹
const KIND = {
  glasses: { r: 21, label: "眼镜" },
  necklace: { r: 22, label: "项链" },
  earring: { r: 17, label: "耳环" },
  ring: { r: 16, label: "戒指" },
  brooch: { r: 18, label: "胸针" },
  hairpin: { r: 19, label: "发夹" },
};
// 不能碰的：虫子、裸露在外通着电的插头
const HAZARD = {
  bug: { r: 19, label: "虫子" },
  plug: { r: 20, label: "插头" },
};
const isHazard = (k) => k === "bug" || k === "plug";

const TREASURE_PLAN = ["glasses", "necklace", "earring", "ring", "brooch", "hairpin", "glasses"];
const HAZARD_PLAN = ["bug", "plug", "bug"];

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
  pops: [],          // 画面上冒出来的短句（"找到了！" / "哎呀！虫子"）
  flash: 0,
  flashColor: "226,75,74",
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
const sfxBug = () => beep([300, 220, 150], "square", 0.08);
const sfxZap = () => beep([90, 1100, 70], "sawtooth", 0.14);
const sfxMiss = () => beep([220], "sine", 0.08);
const sfxWin = () => beep([523, 659, 784, 1047], "triangle", 0.14);
const sfxLose = () => beep([330, 220, 160], "sawtooth", 0.2);

// 撞到虫子/插头时整个浏览器窗口一起抖（不只是画布里抖）
let quakeTimer = 0;
function quakeWindow() {
  document.body.classList.remove("quake");
  void document.body.offsetWidth; // 强制重排，动画才会重新播一遍
  document.body.classList.add("quake");
  clearTimeout(quakeTimer);
  quakeTimer = setTimeout(() => document.body.classList.remove("quake"), 720);
}

// 画面上冒出来的短句
function addPop(text, pos, color = C.gold) {
  if (!game.pops) game.pops = [];
  game.pops.push({ text, x: pos.x, y: pos.y, color, t: 0 });
}

// ---------- 桌面上的东西怎么摆 ----------
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
  snap.canvas = null;   // 上一局的定格帧不留下
  snap.label = "";
  el.save.hidden = true;
  layout();
  syncHud();
  if (game.input === "head") setStatus("奶奶要看清了 —— 身体往左/右挪一点，手就朝那边伸过去");
  else if (game.input === "arm") setStatus("准备好了 —— 向斜上方伸出一只手臂并保持住");
  else setStatus("按住鼠标，朝首饰的方向拖");
}

// ---------- HUD ----------
function syncHud() {
  el.score.textContent = String(game.score);
  el.left.textContent = String(game.items.filter((i) => !isHazard(i.kind)).length);
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
        setStatus(`找到了${KIND[arm.carry.kind].label}！+1 分`);
        addPop(`找到${KIND[arm.carry.kind].label}！`, tipPos(), C.gold);
        arm.carry = null;
        syncHud();
        if (game.items.filter((i) => !isHazard(i.kind)).length === 0) finish(true);
      } else if (game.phase === "playing") {
        if (game.hurtMsg) setStatus(game.hurtMsg);
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
        if (isHazard(it.kind)) {
          game.lives -= 1;
          const hurt = HAZARD[it.kind].label;
          if (it.kind === "bug") {
            game.flash = 0.55;
            game.flashColor = "74,209,79";         // 虫子：恶心的绿
            addPop("啊——虫子！", tipPos(), C.green);
            sfxBug();
          } else {
            game.flash = 0.55;
            game.flashColor = "30,123,232";        // 插头：电光蓝
            addPop("哎哟！有电！", tipPos(), C.blue);
            sfxZap();
          }
          // 整面画布 + 整个窗口一起震
          game.shake = 0.75;
          quakeWindow();
          arm.mode = "back";
          const left = Math.max(game.lives, 0);
          setStatus(`碰到${hurt}！手缩回来了 —— 还剩 ${left} 次机会`);
          if (game.lives > 0) game.hurtMsg = `刚才碰到的是${hurt} —— ${relaxHint()}`;
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
    setStatus(`首饰全找齐了！共 ${game.score} 件 —— 点「重来一局」`);
    sfxWin();
  } else {
    setStatus("哎呀，折腾坏了 —— 点「重来一局」再找一次");
    sfxLose();
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

// 一段粗笔完成下面再压一层细笔 effect：所有手臂/线条都靠这个，保证有描边感
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

// ---------- 杂乱的桌面（画一次，存成离屏图层） ----------
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

  // 铺开的一叠旧报纸：给首饰一个干净点的舞台
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
  // 左上：搪瓷茶杯 + 一缕热气
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

  // 右上：药瓶们
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
    // 撒出来的药片
    for (let i = 0; i < 5; i++) {
      disc(x - 30 * s + i * 22 * s, y + 14 * s + _h(i) * 10, 6, {
        fill: i % 2 ? C.cream : C.yellow, stroke: INK, lw: 2, seed: 140 + i, n: 10, amt: 1.2, passes: 1,
      });
    }
  })(790, 150, 1.0);

  // 左下：毛线团 + 两根毛衣针
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

  // 右下：一摞信和明信片
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

  // 散落的纽扣、线轴、顶针
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
    // 线轴 + 顶针
    ink(rectPts(206, 600, 34, 40), { fill: C.yellow, stroke: INK, lw: 3, seed: 280 });
    disc(223, 594, 20, { fill: C.orange, stroke: INK, lw: 2.4, squash: 0.4, seed: 281 });
    disc(748, 610, 15, { fill: C.teal, stroke: INK, lw: 2.6, squash: 0.85, seed: 282, n: 12 });
  })();
}

// ---------- 桌面上的东西 ----------
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
  pen.rotate(Math.sin(it.bob) * 0.09);           // 每件东西都歪一点，不像图标
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
    default: { // hairpin 发夹
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
    // 头 + 触角
    disc(-r * 0.88, 0, r * 0.3, { fill: C.purple, stroke: INK, lw: 2.6, seed: 160, n: 10 });
    bar(-r * 1.05, -r * 0.1, -r * 1.45, -r * 0.62, INK, 2.6, 161);
    bar(-r * 1.05, r * 0.1, -r * 1.5, r * 0.58, INK, 2.6, 162);
  } else {
    halo(r + 11, C.blue, it, 0.5);
    // 拖出来的电线
    const cord = [];
    for (let i = 0; i <= 10; i++) {
      const u = i / 10;
      cord.push({ x: r * 0.5 + u * r * 1.0, y: r * 0.55 + Math.sin(u * 3.2 + 1) * r * 0.45 });
    }
    ink(cord, { stroke: INK, lw: 9, close: false, seed: 170, amt: 1.4, passes: 1 });
    ink(cord, { stroke: C.deep, lw: 5, close: false, seed: 171, amt: 1.4, passes: 1 });
    // 插头本体 + 两个插脚
    ink(rectPts(-r * 0.72, -r * 0.3, r * 1.4, r * 1.0), { fill: "#3A2F4A", stroke: INK, lw: 3.4, seed: 175, amt: 2.4 });
    ink(rectPts(-r * 0.45, -r * 1.02, r * 0.24, r * 0.78), { fill: C.gold, stroke: INK, lw: 2.6, seed: 176, amt: 1.4 });
    ink(rectPts(r * 0.2, -r * 1.02, r * 0.24, r * 0.78), { fill: C.gold, stroke: INK, lw: 2.6, seed: 177, amt: 1.4 });
    // 裸露的铜线，噼啪冒火花
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

// ---------- 老奶奶（摄像头那格就是她的脸） ----------
function drawShawl() {
  const { x, y, w, h } = PANEL;
  const sy = y + h * 0.66;             // 披肩从画面下沿 1/3 处盖上来 = 她的肩膀
  ink([
    { x: x - 40, y: y + h + 26 },
    { x: x - 6, y: sy + 6 },
    { x: x + w / 2, y: sy - 6 },
    { x: x + w + 6, y: sy + 6 },
    { x: x + w + 40, y: y + h + 26 },
  ], { fill: C.teal, stroke: INK, lw: 4, seed: 350, amt: 3 });
  // 针织罗纹
  for (let i = 0; i < 4; i++) {
    const ry = sy + 14 + i * (h * 0.3 / 4);
    const inset = 26 + i * 10;
    bar(x + inset, ry, x + w - inset, ry + 6, "rgba(255,255,255,0.3)", 3, 360 + i);
  }
  // 领口滚边
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
  // 两边的白发
  for (const side of [-1, 1]) {
    for (let i = 0; i < 5; i++) {
      disc(x + (side > 0 ? w + 5 : -5), y + 30 + i * 40, 16 - i * 1.4, {
        fill: "#FAF3E7", stroke: INK, lw: 2.4, seed: 500 + side * 7 + i, amt: 2, passes: 1,
      });
    }
  }
  drawShawl();
}

// ---------- 伸出去的那只手 ----------
function drawArm() {
  const arm = game.arm;
  if (arm.len <= 3) return;
  const tip = tipPos();
  const mx = ANCHOR.x + arm.dir.x * arm.len * 0.5;
  const my = ANCHOR.y + arm.dir.y * arm.len * 0.5;
  const ang = Math.atan2(arm.dir.y, arm.dir.x);

  // 针织袖
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

  // 前臂 + 老年斑
  thickLine(mx, my, tip.x, tip.y, C.skin, 13);
  for (let i = 0; i < 4; i++) {
    const u = 0.2 + i * 0.2;
    disc(mx + (tip.x - mx) * u + nx * 3, my + (tip.y - my) * u + ny * 3, 2.2, {
      fill: C.skinShade, stroke: null, seed: 430 + i, n: 6, amt: 1, passes: 1,
    });
  }

  // 手：抓住东西时手指并拢，没抓到时张着
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
    ctx.fillStyle = "#8C7BB5";
    ctx.font = "13px system-ui";
    ctx.textAlign = "center";
    ctx.fillText(game.input === "mouse" ? "鼠标模式 · 没用摄像头" : "摄像头还没亮", x + w / 2, y + h / 2);
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

  ctx.strokeStyle = INK; ctx.lineWidth = 2;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  ctx.fillStyle = "#8C7BB5"; ctx.font = "12px system-ui";
  ctx.textAlign = "center";
  ctx.fillText("镜子里是奶奶 —— 画面只在本地，不上传", x + w / 2, y - 9);
  if (game.debug) {
    ctx.fillStyle = "#CDB4FF";
    ctx.fillText(game.debug, x + w / 2, y - 24);
  }
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
  const won = game.items.filter((i) => !isHazard(i.kind)).length === 0;
  ctx.fillStyle = "rgba(43,21,51,0.86)";
  ctx.fillRect(0, 0, W, H);

  ctx.textAlign = "center";
  ctx.fillStyle = won ? C.yellow : "#F6EFE6";
  ctx.font = "500 32px system-ui";
  ctx.fillText(won ? "首饰都找齐了！" : "今天就找到这儿吧", W / 2, 104);

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
    const g = ctx.createLinearGradient(0, py + ph * 0.5, 0, py + ph);
    g.addColorStop(0, "rgba(43,21,51,0)");
    g.addColorStop(1, "rgba(43,21,51,0.85)");
    ctx.fillStyle = g;
    ctx.fillRect(px, py + ph * 0.5, pw, ph * 0.5);
    ctx.fillStyle = "#FFF4DC";
    ctx.font = "500 18px system-ui";
    ctx.fillText(
      snap.label ? `最后找到的是：${snap.label}` : "她在找东西的那一刻",
      W / 2, py + ph - 22
    );
  } else {
    ctx.fillStyle = "#8C7BB5";
    ctx.font = "14px system-ui";
    ctx.fillText("这一局没有摄像头画面（鼠标模式）", W / 2, py + ph / 2);
  }
  ctx.restore();

  ctx.strokeStyle = won ? C.yellow : "#8C7BB5";
  ctx.lineWidth = 3;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(px, py, pw, ph, 12); else ctx.rect(px, py, pw, ph);
  ctx.stroke();

  ctx.fillStyle = "#FFF4DC";
  ctx.font = "500 20px system-ui";
  ctx.fillText(`找到 ${game.score} 件首饰`, W / 2, py + ph + 44);
  ctx.font = "14px system-ui";
  ctx.fillStyle = "#CDB4FF";
  ctx.fillText(
    snap.canvas ? "点「保存这一帧」存成 PNG · 点「重来一局」再找一次" : "点上方「重来一局」再找一次",
    W / 2, py + ph + 76
  );
  ctx.textAlign = "left";
}

function drawOverlay() {
  if (game.flash > 0) {
    ctx.fillStyle = `rgba(${game.flashColor},${Math.min(0.62, game.flash * 0.72)})`;
    ctx.fillRect(0, 0, W, H);
  }
  if (game.phase === "over") {
    drawResult();
  } else if (game.phase === "ready") {
    ctx.fillStyle = "rgba(43,21,51,0.62)";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#FFF4DC";
    ctx.font = "500 26px system-ui";
    ctx.textAlign = "center";
    ctx.fillText("帮老奶奶找她的首饰", W / 2, H / 2 - 6);
    ctx.font = "15px system-ui";
    ctx.fillStyle = "#CDB4FF";
    ctx.fillText("点下方「开始」，站到镜头前", W / 2, H / 2 + 26);
    ctx.textAlign = "left";
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
  for (const it of game.items) drawItem(it);
  drawArm();
  if (game.arm.carry) {
    const tip = tipPos();
    drawItem({ ...game.arm.carry, x: tip.x, y: tip.y + 18, bob: 0 });
  }
  drawPops();
  ctx.restore();
  drawPanel();
  drawGranny();
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

  if (game.flash > 0) game.flash = Math.max(0, game.flash - dt * 1.2);
  if (game.shake > 0) game.shake = Math.max(0, game.shake - dt * 1.1); // 抖久一点，撞一次要吓一跳
  if (game.pops) game.pops = game.pops.filter((p) => (p.t += dt) < 1.1);

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
