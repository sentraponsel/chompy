'use strict';
/* CHOMPY – game makan-makan berkontrol wajah / tangan / sentuh */

const $ = s => document.querySelector(s);
const cv = $('#cv'), ctx = cv.getContext('2d'), video = $('#cam');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rnd = (a, b) => a + Math.random() * (b - a);

/* ---------- ukuran layar ---------- */
let W = 0, H = 0, u = 1, dpr = 1, safeTop = 0, safeBot = 0;
function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth; H = window.innerHeight;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  cv.style.width = W + 'px'; cv.style.height = H + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  u = Math.max(.8, Math.min(1.5, Math.min(W, H * .62) / 390));
  safeTop = $('#sat').getBoundingClientRect().height || 0;
  safeBot = $('#satb').getBoundingClientRect().height || 0;
}
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 200));
resize();

/* ---------- suara ---------- */
let ac = null, muted = localStorage.getItem('chompy-mute') === '1';
function audio() {
  if (!ac) { try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { /* tanpa suara */ } }
  if (ac && ac.state === 'suspended') ac.resume();
  return ac;
}
function tone(f, d = .1, type = 'sine', v = .15, slide = 0, delay = 0) {
  if (muted) return;
  const a = audio(); if (!a) return;
  const t0 = a.currentTime + delay;
  const o = a.createOscillator(), g = a.createGain();
  o.type = type; o.frequency.setValueAtTime(f, t0);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, f + slide), t0 + d);
  g.gain.setValueAtTime(v, t0);
  g.gain.exponentialRampToValueAtTime(.0001, t0 + d);
  o.connect(g); g.connect(a.destination);
  o.start(t0); o.stop(t0 + d + .03);
}
const sfx = {
  eat: c => tone(380 + Math.min(c, 20) * 28, .12, 'triangle', .2, 200),
  star: () => [660, 880, 1175].forEach((f, i) => tone(f, .16, 'square', .09, 0, i * .07)),
  bomb: () => { tone(140, .45, 'sawtooth', .22, -100); tone(70, .5, 'square', .18, -30); },
  miss: () => tone(200, .15, 'sine', .1, -80),
  bounce: () => tone(520, .08, 'sine', .1, -200),
  power: () => [300, 450, 600, 900].forEach((f, i) => tone(f, .22, 'sine', .15, 0, i * .06)),
  over: () => [400, 320, 250, 160].forEach((f, i) => tone(f, .3, 'sawtooth', .13, -40, i * .18)),
  tick: () => tone(700, .07, 'square', .07),
  go: () => tone(1000, .25, 'square', .1)
};
const vib = p => { try { if (navigator.vibrate) navigator.vibrate(p); } catch (e) { /* abaikan */ } };

/* ---------- kamera & model AI ---------- */
const VISION_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';
const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const HAND_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

let stream = null, tv = null, fileset = null, faceLM = null, handLM = null;

async function startCam() {
  if (stream && stream.active) { video.hidden = false; return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('Browser ini tidak mendukung kamera (butuh HTTPS).');
  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false
  });
  video.srcObject = stream;
  video.hidden = false;
  await video.play();
}
function stopCam() {
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  video.srcObject = null; video.hidden = true;
}
async function makeLM(fn) {
  let lastErr;
  for (const d of ['GPU', 'CPU']) {
    try { return await fn(d); } catch (e) { lastErr = e; console.warn('delegate', d, e); }
  }
  throw lastErr || new Error('Model gagal dimuat');
}
async function ensureModels(m, setMsg) {
  if (!tv) {
    setMsg('Memuat mesin AI…');
    tv = await import(VISION_URL);
    fileset = await tv.FilesetResolver.forVisionTasks(WASM_URL);
  }
  if (m === 'face' && !faceLM) {
    setMsg('Memuat model wajah…');
    faceLM = await makeLM(d => tv.FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: FACE_MODEL, delegate: d },
      runningMode: 'VIDEO', numFaces: 1, outputFaceBlendshapes: true
    }));
  }
  if (m === 'hand' && !handLM) {
    setMsg('Memuat model tangan…');
    handLM = await makeLM(d => tv.HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: HAND_MODEL, delegate: d },
      runningMode: 'VIDEO', numHands: 1
    }));
  }
}

/* ---------- state ---------- */
let mode = 'face', state = 'menu';
const inp = { x: .5, mouth: 0, blink: false, seen: 0 };
let px = 0, py = 0, mo = 0;
let handPts = null;
let items = [], parts = [], texts = [];
let score = 0, best = +localStorage.getItem('chompy-best') || 0;
let hunger = 75, combo = 0, maxCombo = 0, eaten = 0, t = 0, spawnT = 0;
let charge = 0, freezeT = 0, frenzyT = 0, nextFrenzy = 30;
let shake = 0, flash = 0, flashCol = '#fff', cd = 3, lastCdN = 4;
let blinkHold = 0, blinkLatch = false, lookX = 0, lookY = 0, bounceCool = 0, missCool = 0;
let lastVT = -1, lastTs = 0;
const stars = Array.from({ length: 55 }, () => ({ x: Math.random(), y: Math.random(), s: Math.random() * 1.6 + .4, v: Math.random() * .03 + .01 }));
const FRUITS = ['🍎', '🍓', '🍌', '🍇', '🍉', '🍊', '🍍', '🍒'];
const mult = () => 1 + Math.min(5, Math.floor(combo / 5));
const R = () => 44 * u;

/* ---------- pelacakan ---------- */
function track(now) {
  if (mode === 'touch' || !stream || video.readyState < 2 || !video.videoWidth) return;
  if (video.currentTime === lastVT) return;
  lastVT = video.currentTime;
  let ts = performance.now(); if (ts <= lastTs) ts = lastTs + 1; lastTs = ts;
  try {
    if (mode === 'face' && faceLM) {
      const r = faceLM.detectForVideo(video, ts);
      if (r.faceLandmarks && r.faceLandmarks.length) {
        const l = r.faceLandmarks[0];
        const bs = {};
        if (r.faceBlendshapes && r.faceBlendshapes[0]) for (const c of r.faceBlendshapes[0].categories) bs[c.categoryName] = c.score;
        inp.x = clamp((1 - l[1].x - .5) * 2.6 + .5, 0, 1);
        inp.mouth = clamp(((bs.jawOpen || 0) - .1) / .35, 0, 1);
        inp.blink = ((bs.eyeBlinkLeft || 0) + (bs.eyeBlinkRight || 0)) / 2 > .55;
        inp.seen = now;
      }
    } else if (mode === 'hand' && handLM) {
      const r = handLM.detectForVideo(video, ts);
      if (r.landmarks && r.landmarks.length) {
        const l = r.landmarks[0], vw = video.videoWidth, vh = video.videoHeight;
        const dist = (a, b) => Math.hypot((l[a].x - l[b].x) * vw, (l[a].y - l[b].y) * vh);
        const palm = dist(0, 9) || 1;
        inp.x = clamp((1 - l[9].x - .5) * 1.5 + .5, 0, 1);
        inp.mouth = clamp((dist(4, 8) / palm - .25) / .55, 0, 1);
        inp.seen = now;
        handPts = [4, 8, 9].map(i => ({ x: (1 - l[i].x) * W, y: l[i].y * H }));
      } else handPts = null;
    }
  } catch (e) { console.warn('track', e); }
}

/* ---------- efek ---------- */
function burst(x, y, col, n = 14, sp = 260) {
  for (let i = 0; i < n; i++) {
    const a = rnd(0, 6.283), s = rnd(.3, 1) * sp * u, life = rnd(.4, .85);
    parts.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 60 * u, life, max: life, col, sz: rnd(2.5, 6) * u });
  }
}
function pop(x, y, text, col, size = 22) { texts.push({ x, y, text, col, life: 1, size }); }

/* ---------- alur game ---------- */
function resetGame() {
  items = []; parts = []; texts = [];
  score = 0; hunger = 75; combo = 0; maxCombo = 0; eaten = 0; t = 0; spawnT = .5;
  charge = 0; freezeT = 0; frenzyT = 0; nextFrenzy = 30; shake = 0; flash = 0;
  blinkHold = 0; blinkLatch = false; cd = 3; lastCdN = 4;
  px = W / 2; py = H * .78; mo = 0; inp.x = .5; inp.mouth = 0;
}
function spawn() {
  let r = rnd(.9, 1.08) * 26 * u;
  const bombP = Math.min(.10 + t * .0025, .30) * (frenzyT > 0 ? .5 : 1);
  const q = Math.random();
  let type;
  if (q < bombP) type = 'bomb';
  else if (q < bombP + .05) type = 'star';
  else if (q < bombP + .11) type = 'burger';
  else type = 'fruit';
  if (type === 'burger') r *= 1.15;
  const emo = type === 'bomb' ? '💣' : type === 'star' ? '⭐' : type === 'burger' ? '🍔' : FRUITS[(Math.random() * FRUITS.length) | 0];
  items.push({
    x: rnd(r + 8, W - r - 8), y: -r, r, type, emo,
    vy: (190 + Math.min(t, 150) * 3.4) * u * rnd(.85, 1.2), vx: 0,
    sway: rnd(0, 34) * u, ph: rnd(0, 6.283), rot: rnd(-.5, .5), spin: rnd(-2, 2), bounced: false, dead: false
  });
}
const GAIN = { fruit: { pts: 10, hun: 7, ch: 7 }, star: { pts: 50, hun: 18, ch: 14 }, burger: { pts: 25, hun: 16, ch: 8 } };

function eat(it) {
  it.dead = true;
  if (it.type === 'bomb') {
    hunger -= 30; combo = 0; shake = 18; flash = .8; flashCol = '#ff3b3b';
    burst(it.x, it.y, '#ff7a3b', 26, 380); burst(it.x, it.y, '#ffd24a', 12, 260);
    pop(px, py - R() * 1.7, 'BOOM! -30', '#ff6b6b', 28);
    sfx.bomb(); vib([70, 40, 70]);
    return;
  }
  const g = GAIN[it.type];
  combo++; maxCombo = Math.max(maxCombo, combo); eaten++;
  const m = mult() * (freezeT > 0 ? 2 : 1);
  const pts = g.pts * m;
  score += pts;
  hunger = Math.min(100, hunger + g.hun);
  charge = Math.min(100, charge + g.ch);
  burst(it.x, it.y, it.type === 'star' ? '#ffe45c' : '#7dff9b', it.type === 'star' ? 22 : 12, 240);
  pop(it.x, it.y - 10 * u, '+' + pts, it.type === 'star' ? '#ffe45c' : '#fff', it.type === 'star' ? 28 : 22);
  if (combo > 0 && combo % 5 === 0) { pop(W / 2, H * .42, 'COMBO ×' + mult() + '!', '#ff9ad5', 32); flash = .3; flashCol = '#ff9ad5'; }
  it.type === 'star' ? sfx.star() : sfx.eat(combo);
  vib(8);
}
function tryPower() {
  if (state !== 'play' || charge < 100) return;
  charge = 0; freezeT = 3.5; flash = .7; flashCol = '#7fe3ff';
  pop(W / 2, H * .38, '❄️ WAKTU BEKU! ×2', '#aef0ff', 34);
  burst(W / 2, H * .5, '#bff3ff', 40, 420);
  sfx.power(); vib([30, 30, 60]);
}
function gameOver() {
  state = 'over';
  sfx.over(); vib([120, 60, 200]);
  const isNew = score > best;
  if (isNew) { best = score; try { localStorage.setItem('chompy-best', String(best)); } catch (e) { /* abaikan */ } }
  setTimeout(() => {
    if (state !== 'over') return;
    $('#overTitle').textContent = isNew ? '🏆 REKOR BARU!' : 'KELAPARAN! 💀';
    $('#overScore').textContent = score.toLocaleString('id-ID');
    $('#overBest').textContent = 'Rekor: ' + best.toLocaleString('id-ID');
    $('#overStats').innerHTML = `<div>Dimakan<br><b>${eaten}</b></div><div>Combo maks<br><b>${maxCombo}</b></div>` +
      `<div>Bertahan<br><b>${Math.floor(t)} dtk</b></div><div>Mode<br><b>${{ face: 'Wajah', hand: 'Tangan', touch: 'Sentuh' }[mode]}</b></div>`;
    $('#over').hidden = false;
    $('#power').hidden = true;
  }, 700);
}

/* ---------- update ---------- */
function update(dt, now) {
  const present = mode === 'touch' || now - inp.seen < 700;
  px += (inp.x * W - px) * Math.min(1, dt * 14);
  mo += (inp.mouth - mo) * Math.min(1, dt * 20);
  shake = Math.max(0, shake - dt * 40);
  flash = Math.max(0, flash - dt * 2.2);
  bounceCool = Math.max(0, bounceCool - dt);
  missCool = Math.max(0, missCool - dt);

  for (const p of parts) { p.life -= dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 700 * u * dt; }
  parts = parts.filter(p => p.life > 0);
  for (const s of texts) { s.life -= dt * 1.1; s.y -= 55 * u * dt; }
  texts = texts.filter(s => s.life > 0);
  for (const s of stars) { s.y += s.v * dt * (freezeT > 0 ? .3 : 1); if (s.y > 1) { s.y = 0; s.x = Math.random(); } }

  if (state === 'countdown') {
    cd -= dt;
    const n = Math.ceil(cd);
    if (n !== lastCdN) { lastCdN = n; n > 0 ? sfx.tick() : sfx.go(); }
    if (cd <= -.45) state = 'play';
    return;
  }
  if (state !== 'play' || !present) return;

  t += dt;
  if (freezeT > 0) freezeT = Math.max(0, freezeT - dt);
  if (frenzyT > 0) frenzyT = Math.max(0, frenzyT - dt);
  if (t >= nextFrenzy) { frenzyT = 5; nextFrenzy += 30; pop(W / 2, H * .34, '🔥 FRENZY! 🔥', '#ffb300', 34); sfx.star(); }

  // kedip lama = kekuatan beku
  if (mode === 'face') {
    if (inp.blink) { blinkHold += dt; if (blinkHold > .28 && !blinkLatch) { blinkLatch = true; tryPower(); } }
    else { blinkHold = 0; blinkLatch = false; }
  }

  hunger -= (2.4 + Math.min(t, 120) * .045) * (freezeT > 0 ? .4 : 1) * dt;
  if (hunger <= 0) { hunger = 0; gameOver(); return; }

  spawnT -= dt;
  if (spawnT <= 0) {
    spawn();
    spawnT = Math.max(.36, .95 - t * .012) * (frenzyT > 0 ? .45 : 1) * rnd(.8, 1.2);
  }

  const ts = freezeT > 0 ? .2 : 1;
  const mx = px, my = py - R() * .45;
  let nearest = null, nd = 1e9;
  for (const it of items) {
    it.y += it.vy * ts * dt;
    it.x += Math.cos(t * 3 + it.ph) * it.sway * ts * dt + it.vx * dt;
    it.vx *= .985;
    it.rot += it.spin * ts * dt;
    if (it.vy < 0) it.vy += 900 * u * dt;
    const d = Math.hypot(it.x - mx, it.y - my);
    if (it.type !== 'bomb' && !it.bounced && it.y < py && d < nd) { nd = d; nearest = it; }
    if (it.dead) continue;
    if (mo > .35 && d < R() * .85 + it.r * .2 && it.vy > 0) { eat(it); continue; }
    if (d < R() * .8 + it.r * .5 && it.vy > 0 && !it.bounced) {
      it.bounced = true; it.vy = -Math.abs(it.vy) * .55;
      it.vx = (it.x < px ? -1 : 1) * rnd(120, 240) * u;
      if (bounceCool <= 0) { sfx.bounce(); bounceCool = .12; }
      burst(it.x, it.y, '#ffffff', 5, 140);
      if (it.type !== 'bomb') pop(it.x, it.y - 20 * u, 'Buka mulut!', '#ffd1e8', 15);
      continue;
    }
    if (it.y > H + it.r) {
      it.dead = true;
      if (it.type !== 'bomb' && !it.bounced) {
        combo = 0; hunger -= 5;
        if (missCool <= 0) { sfx.miss(); missCool = .15; }
      }
    }
    if (it.y < -120 || it.x < -80 || it.x > W + 80) it.dead = true;
  }
  items = items.filter(i => !i.dead);
  if (nearest) { const dx = nearest.x - mx, dy = nearest.y - my, l = Math.hypot(dx, dy) || 1; lookX += (dx / l - lookX) * .2; lookY += (dy / l - lookY) * .2; }
  else { lookX *= .9; lookY *= .9; }

  $('#power').hidden = !(charge >= 100);
}

/* ---------- gambar ---------- */
function rr(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function drawBG() {
  const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * .25, W / 2, H / 2, Math.max(W, H) * .75);
  g.addColorStop(0, 'rgba(10,0,30,0)'); g.addColorStop(1, 'rgba(10,0,30,.65)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#fff';
  for (const s of stars) { ctx.globalAlpha = .25 + s.s * .2; ctx.beginPath(); ctx.arc(s.x * W, s.y * H, s.s * u, 0, 6.283); ctx.fill(); }
  ctx.globalAlpha = 1;
  if (freezeT > 0) { ctx.fillStyle = 'rgba(120,220,255,' + (.10 + Math.sin(performance.now() / 120) * .03) + ')'; ctx.fillRect(0, 0, W, H); }
  if (frenzyT > 0) { ctx.fillStyle = 'rgba(255,150,0,.07)'; ctx.fillRect(0, 0, W, H); }
}
function drawItems(now) {
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const it of items) {
    ctx.save(); ctx.translate(it.x, it.y); ctx.rotate(it.rot);
    if (it.type === 'bomb') {
      const p = .5 + .5 * Math.sin(now / 130);
      ctx.strokeStyle = 'rgba(255,60,60,' + (.45 + p * .5) + ')'; ctx.lineWidth = 3 * u;
      ctx.beginPath(); ctx.arc(0, 0, it.r * (1.2 + p * .12), 0, 6.283); ctx.stroke();
    } else if (it.type === 'star') {
      ctx.fillStyle = 'rgba(255,230,90,.25)'; ctx.beginPath(); ctx.arc(0, 0, it.r * 1.4, 0, 6.283); ctx.fill();
    }
    ctx.font = `${it.r * 1.9}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
    ctx.fillText(it.emo, 0, 2 * u);
    ctx.restore();
  }
}
function drawPlayer(now) {
  const r = R();
  ctx.save(); ctx.translate(px, py);
  ctx.fillStyle = 'rgba(0,0,0,.28)'; ctx.beginPath(); ctx.ellipse(0, r * 1.02, r * .85, r * .18, 0, 0, 6.283); ctx.fill();
  const wob = Math.sin(now * .008) * .03;
  ctx.scale(1 + wob + mo * .06, 1 - wob);
  const hue = freezeT > 0 ? 195 : (285 + (mult() - 1) * 28) % 360;
  const bg = ctx.createRadialGradient(-r * .3, -r * .35, r * .1, 0, 0, r * 1.1);
  bg.addColorStop(0, `hsl(${hue},85%,72%)`); bg.addColorStop(1, `hsl(${hue},75%,45%)`);
  ctx.fillStyle = bg; ctx.beginPath(); ctx.arc(0, 0, r, 0, 6.283); ctx.fill();
  ctx.lineWidth = 3 * u; ctx.strokeStyle = `hsl(${hue},70%,28%)`; ctx.stroke();
  // mulut (baji menghadap atas)
  const a = .07 + mo * 1.0;
  ctx.fillStyle = '#3a0a24';
  ctx.beginPath(); ctx.moveTo(0, r * .05); ctx.arc(0, r * .05, r * .97, -Math.PI / 2 - a, -Math.PI / 2 + a); ctx.closePath(); ctx.fill();
  if (mo > .25) {
    ctx.fillStyle = '#ff7aa8'; ctx.beginPath(); ctx.ellipse(0, -r * .2, r * .3 * mo, r * .16 * mo, 0, 0, 6.283); ctx.fill();
    ctx.fillStyle = '#fff';
    for (const sgn of [-1, 1]) {
      const ang = -Math.PI / 2 + sgn * a * .94, tx = Math.cos(ang) * r * .95, ty = r * .05 + Math.sin(ang) * r * .95;
      ctx.beginPath(); ctx.arc(tx, ty, r * .09, 0, 6.283); ctx.fill();
    }
  }
  // mata
  for (const sgn of [-1, 1]) {
    const ex = sgn * r * .42, ey = r * .26;
    if (inp.blink && mode === 'face') {
      ctx.strokeStyle = '#1b0630'; ctx.lineWidth = 3 * u; ctx.beginPath(); ctx.arc(ex, ey, r * .16, .15 * Math.PI, .85 * Math.PI); ctx.stroke();
    } else {
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(ex, ey, r * .2, 0, 6.283); ctx.fill();
      ctx.fillStyle = '#1b0630'; ctx.beginPath(); ctx.arc(ex + lookX * r * .07, ey + lookY * r * .07, r * .1, 0, 6.283); ctx.fill();
    }
  }
  ctx.restore();
}
function drawHand() {
  if (mode !== 'hand' || !handPts || state === 'menu') return;
  const [a, b, c] = handPts;
  ctx.strokeStyle = 'rgba(255,255,255,.6)'; ctx.lineWidth = 3 * u; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  for (const p of [a, b]) { ctx.fillStyle = '#7fe3ff'; ctx.beginPath(); ctx.arc(p.x, p.y, 8 * u, 0, 6.283); ctx.fill(); }
  ctx.fillStyle = 'rgba(255,255,255,.5)'; ctx.beginPath(); ctx.arc(c.x, c.y, 5 * u, 0, 6.283); ctx.fill();
}
function drawFX() {
  for (const p of parts) { ctx.globalAlpha = clamp(p.life / p.max, 0, 1); ctx.fillStyle = p.col; ctx.beginPath(); ctx.arc(p.x, p.y, p.sz, 0, 6.283); ctx.fill(); }
  ctx.globalAlpha = 1; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const s of texts) {
    ctx.globalAlpha = clamp(s.life * 1.6, 0, 1);
    ctx.font = `900 ${s.size * u}px system-ui,sans-serif`;
    ctx.lineWidth = 5 * u; ctx.strokeStyle = 'rgba(20,0,40,.8)'; ctx.strokeText(s.text, s.x, s.y);
    ctx.fillStyle = s.col; ctx.fillText(s.text, s.x, s.y);
  }
  ctx.globalAlpha = 1;
}
function drawHUD(now) {
  const top = safeTop + 12 * u, pad = 16 * u;
  ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
  ctx.font = `900 ${34 * u}px system-ui,sans-serif`; ctx.fillStyle = '#fff';
  ctx.fillText(score.toLocaleString('id-ID'), pad, top + 32 * u);
  ctx.font = `700 ${11 * u}px system-ui,sans-serif`; ctx.fillStyle = 'rgba(255,255,255,.65)';
  ctx.fillText('REKOR ' + best.toLocaleString('id-ID'), pad, top + 48 * u);
  if (combo >= 2) {
    ctx.textAlign = 'right';
    ctx.font = `900 ${30 * u}px system-ui,sans-serif`; ctx.fillStyle = '#ffd36b'; ctx.fillText('×' + mult() * (freezeT > 0 ? 2 : 1), W - pad, top + 30 * u);
    ctx.font = `700 ${11 * u}px system-ui,sans-serif`; ctx.fillStyle = 'rgba(255,255,255,.7)'; ctx.fillText(combo + ' COMBO', W - pad, top + 48 * u);
  }
  const bw = W - pad * 2, by = top + 60 * u, bh = 14 * u;
  ctx.fillStyle = 'rgba(0,0,0,.4)'; rr(pad, by, bw, bh, bh / 2); ctx.fill();
  const hw = Math.max(bh, bw * hunger / 100);
  const low = hunger < 25 && state === 'play';
  ctx.fillStyle = `hsl(${hunger * 1.2},85%,${low ? 50 + Math.sin(now / 90) * 10 : 55}%)`;
  rr(pad, by, hw, bh, bh / 2); ctx.fill();
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.font = `${11 * u}px system-ui,sans-serif`;
  ctx.fillStyle = '#fff'; ctx.fillText('🍽 KENYANG', pad + 8 * u, by + bh / 2 + 1);
  const py2 = by + bh + 6 * u, ph = 8 * u;
  ctx.fillStyle = 'rgba(0,0,0,.4)'; rr(pad, py2, bw, ph, ph / 2); ctx.fill();
  const rdy = charge >= 100;
  ctx.fillStyle = rdy ? `hsl(190,100%,${65 + Math.sin(now / 100) * 10}%)` : '#4aa8d8';
  rr(pad, py2, Math.max(ph, bw * charge / 100), ph, ph / 2); ctx.fill();
  if (rdy && state === 'play') {
    ctx.textAlign = 'center'; ctx.font = `900 ${13 * u}px system-ui,sans-serif`; ctx.fillStyle = '#aef0ff';
    ctx.fillText(mode === 'face' ? '👁 TUTUP MATA SEBENTAR / KETUK ❄️' : 'KETUK ❄️ UNTUK BEKUKAN WAKTU', W / 2, py2 + ph + 16 * u);
  }
  if (freezeT > 0) {
    ctx.textAlign = 'center'; ctx.font = `900 ${14 * u}px system-ui,sans-serif`; ctx.fillStyle = '#aef0ff';
    ctx.fillText('❄️ BEKU ' + freezeT.toFixed(1) + 's', W / 2, py2 + ph + 16 * u);
  }
}
function drawOverlays() {
  if (flash > 0) { ctx.globalAlpha = clamp(flash * .45, 0, .45); ctx.fillStyle = flashCol; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1; }
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  if (state === 'play' && mode !== 'touch' && performance.now() - inp.seen >= 700) {
    ctx.fillStyle = 'rgba(10,0,30,.6)'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#fff'; ctx.font = `900 ${24 * u}px system-ui,sans-serif`;
    ctx.fillText(mode === 'face' ? 'Mana wajahmu? 👀' : 'Tunjukkan tanganmu ✋', W / 2, H * .45);
    ctx.font = `${14 * u}px system-ui,sans-serif`; ctx.fillStyle = 'rgba(255,255,255,.75)';
    ctx.fillText('Game dijeda sampai terdeteksi lagi', W / 2, H * .45 + 30 * u);
  }
  if (state === 'countdown') {
    ctx.fillStyle = 'rgba(10,0,30,.45)'; ctx.fillRect(0, 0, W, H);
    const n = Math.ceil(cd);
    ctx.font = `900 ${110 * u}px system-ui,sans-serif`;
    ctx.lineWidth = 8 * u; ctx.strokeStyle = 'rgba(20,0,40,.8)'; ctx.fillStyle = '#ffd36b';
    const txt = n > 0 ? String(n) : 'GAS!';
    ctx.strokeText(txt, W / 2, H * .36); ctx.fillText(txt, W / 2, H * .36);
    const tips = mode === 'face'
      ? ['Gerakkan kepala ← → untuk menggeser', 'Buka mulut lebar = makan 🍎', 'TUTUP mulut saat 💣 jatuh!']
      : mode === 'hand'
        ? ['Geser tangan ← → untuk menggeser', 'Renggangkan jempol & telunjuk = buka mulut', 'JEPIT jari saat 💣 jatuh!']
        : ['Geser jari ← → untuk menggeser', 'Tahan layar = buka mulut 🍎', 'LEPAS jari saat 💣 jatuh!'];
    ctx.font = `700 ${16 * u}px system-ui,sans-serif`; ctx.fillStyle = '#fff';
    tips.forEach((s, i) => ctx.fillText(s, W / 2, H * .5 + i * 26 * u));
  }
}
function draw(now) {
  ctx.clearRect(0, 0, W, H);
  ctx.save();
  if (shake > 0) ctx.translate(rnd(-shake, shake), rnd(-shake, shake));
  drawBG();
  if (state !== 'menu') { drawItems(now); drawPlayer(now); drawHand(); drawFX(); }
  ctx.restore();
  if (state !== 'menu') drawHUD(now);
  drawOverlays();
}

/* ---------- loop ---------- */
let last = performance.now();
function frame(now) {
  const dt = Math.min(.05, (now - last) / 1000); last = now;
  track(now); update(dt, now); draw(now);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/* ---------- input sentuh ---------- */
function setX(e) { inp.x = clamp(e.clientX / W, 0, 1); }
cv.addEventListener('pointerdown', e => {
  audio();
  if (mode === 'touch' && (state === 'play' || state === 'countdown')) {
    setX(e); inp.mouth = 1; inp.seen = performance.now();
    try { cv.setPointerCapture(e.pointerId); } catch (x) { /* abaikan */ }
  } else tryPower();
  e.preventDefault();
});
cv.addEventListener('pointermove', e => { if (mode === 'touch' && state !== 'menu') setX(e); });
const release = () => { if (mode === 'touch') inp.mouth = 0; };
cv.addEventListener('pointerup', release);
cv.addEventListener('pointercancel', release);
addEventListener('keydown', e => {
  if (mode !== 'touch') return;
  if (e.code === 'Space') { inp.mouth = 1; e.preventDefault(); }
  if (e.code === 'ArrowLeft') inp.x = clamp(inp.x - .06, 0, 1);
  if (e.code === 'ArrowRight') inp.x = clamp(inp.x + .06, 0, 1);
  if (e.code === 'KeyB') tryPower();
});
addEventListener('keyup', e => { if (e.code === 'Space') release(); });
$('#power').addEventListener('pointerdown', e => { e.stopPropagation(); tryPower(); $('#power').hidden = true; });

/* ---------- menu & tombol ---------- */
const showErr = m => { const el = $('#err'); el.textContent = m || ''; el.hidden = !m; };
function updateBest() { $('#bestLine').textContent = best ? '🏆 Rekor kamu: ' + best.toLocaleString('id-ID') : ''; }
updateBest();

async function begin(m) {
  mode = m; showErr('');
  audio();
  $('#menu').hidden = true; $('#over').hidden = true; $('#loading').hidden = false;
  const setMsg = s => { $('#loadMsg').textContent = s; };
  try {
    if (m !== 'touch') {
      setMsg('Menyalakan kamera…');
      await startCam();
      await ensureModels(m, setMsg);
    } else stopCam();
  } catch (e) {
    console.error(e);
    stopCam();
    $('#loading').hidden = true; $('#menu').hidden = false;
    const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
    showErr(denied ? 'Izin kamera ditolak. Aktifkan izin kamera untuk situs ini, atau pakai Mode Sentuh.'
      : 'Gagal: ' + (e && e.message ? e.message : e) + ' — coba lagi atau pakai Mode Sentuh.');
    return;
  }
  $('#loading').hidden = true;
  resetGame();
  inp.seen = performance.now();
  state = 'countdown';
  $('#mute').hidden = false; $('#quit').hidden = false;
  try { if (navigator.wakeLock) navigator.wakeLock.request('screen').catch(() => { }); } catch (e) { /* abaikan */ }
}
function toMenu() {
  state = 'menu'; stopCam(); handPts = null;
  $('#over').hidden = true; $('#power').hidden = true; $('#mute').hidden = true; $('#quit').hidden = true;
  $('#menu').hidden = false; updateBest();
}
document.querySelectorAll('.mode').forEach(b => b.addEventListener('click', () => begin(b.dataset.mode)));
$('#again').addEventListener('click', () => begin(mode));
$('#toMenu').addEventListener('click', toMenu);
$('#quit').addEventListener('click', toMenu);
const muteBtn = $('#mute');
muteBtn.textContent = muted ? '🔇' : '🔊';
muteBtn.addEventListener('click', () => {
  muted = !muted; muteBtn.textContent = muted ? '🔇' : '🔊';
  try { localStorage.setItem('chompy-mute', muted ? '1' : '0'); } catch (e) { /* abaikan */ }
});
if (navigator.share) {
  $('#share').hidden = false;
  $('#share').addEventListener('click', () => {
    navigator.share({ title: 'CHOMPY', text: `Skor aku ${score.toLocaleString('id-ID')} di CHOMPY! Bisa kalahin? 😮🍎`, url: location.href }).catch(() => { });
  });
}

/* ---------- pasang PWA ---------- */
let deferred = null;
addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; $('#install').hidden = false; });
$('#install').addEventListener('click', async () => {
  if (!deferred) return;
  deferred.prompt(); try { await deferred.userChoice; } catch (e) { /* abaikan */ }
  deferred = null; $('#install').hidden = true;
});
addEventListener('appinstalled', () => { $('#install').hidden = true; });
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
if (isIOS && !standalone) $('#iosTip').hidden = false;
