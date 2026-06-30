'use strict';

// ─── Game State (外部から参照できるオブジェクト) ────────────────────────────
const wandState = {
  tipX: null,
  tipY: null,
  velocity: 0,
  isDetected: false,
  trail: [],        // [{x, y, t}]
};

// ─── DOM ─────────────────────────────────────────────────────────────────────
const video    = document.getElementById('video');
const overlay  = document.getElementById('overlay');
const ctx      = overlay.getContext('2d');
const badge    = document.getElementById('status-badge');
const btnStart = document.getElementById('btn-start');
const btnReset = document.getElementById('btn-reset-trail');

const sliderThreshold = document.getElementById('slider-threshold');
const sliderArea      = document.getElementById('slider-area');
const valThreshold    = document.getElementById('threshold-val');
const valArea         = document.getElementById('area-val');

const infoPos  = document.getElementById('info-pos');
const infoVel  = document.getElementById('info-vel');
const infoArea = document.getElementById('info-area');

// ─── Config ──────────────────────────────────────────────────────────────────
let cfg = {
  threshold: 60,   // 赤の判定しきい値 (R - max(G,B) > threshold)
  minArea:   800,  // 最小検出面積 (px²)
};

const TRAIL_MAX_LEN = 60;
const TRAIL_FADE_MS = 1500;
const SAMPLE_STEP   = 3;   // ピクセル解析のサンプリング間隔 (重い場合は増やす)

// ─── State ───────────────────────────────────────────────────────────────────
let running    = false;
let rafId      = null;
let offscreen  = null;
let offCtx     = null;

// ─── Magic Effects State ──────────────────────────────────────────────────────
const MAGIC_COLORS = ['#ffffff', '#ffd700', '#ff88ff', '#aa88ff', '#88ddff', '#ffcc44'];
const particles  = [];
const pulseRings = [];
let pulseTimer   = 0;
let circleAngle  = 0;

// ─── Slider listeners ────────────────────────────────────────────────────────
sliderThreshold.addEventListener('input', () => {
  cfg.threshold = +sliderThreshold.value;
  valThreshold.textContent = cfg.threshold;
});

sliderArea.addEventListener('input', () => {
  cfg.minArea = +sliderArea.value;
  valArea.textContent = cfg.minArea;
});

// ─── Camera Start / Stop ─────────────────────────────────────────────────────
btnStart.addEventListener('click', async () => {
  if (running) {
    stopCamera();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    running = true;
    btnStart.textContent = 'カメラ停止';
    btnStart.classList.add('active');
    initOffscreen();
    loop();
  } catch (e) {
    alert('カメラを開けませんでした: ' + e.message);
  }
});

function stopCamera() {
  running = false;
  cancelAnimationFrame(rafId);
  const tracks = video.srcObject?.getTracks() ?? [];
  tracks.forEach(t => t.stop());
  video.srcObject = null;
  btnStart.textContent = 'カメラ開始';
  btnStart.classList.remove('active');
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  setUndetected();
}

btnReset.addEventListener('click', () => {
  wandState.trail = [];
});

// ─── Resize overlay to match video ───────────────────────────────────────────
function syncSize() {
  const rect = video.getBoundingClientRect();
  if (overlay.width !== rect.width || overlay.height !== rect.height) {
    overlay.width  = rect.width;
    overlay.height = rect.height;
  }
}

function initOffscreen() {
  offscreen = document.createElement('canvas');
  offscreen.width  = video.videoWidth  || 640;
  offscreen.height = video.videoHeight || 480;
  offCtx = offscreen.getContext('2d', { willReadFrequently: true });
}

// ─── Main loop ───────────────────────────────────────────────────────────────
function loop() {
  if (!running) return;
  rafId = requestAnimationFrame(loop);

  if (!video.videoWidth) return;

  syncSize();

  // 解像度が変わったら更新
  if (offscreen.width !== video.videoWidth || offscreen.height !== video.videoHeight) {
    offscreen.width  = video.videoWidth;
    offscreen.height = video.videoHeight;
  }

  offCtx.drawImage(video, 0, 0, offscreen.width, offscreen.height);
  const imageData = offCtx.getImageData(0, 0, offscreen.width, offscreen.height);
  const result    = detectRed(imageData);

  updateState(result);
  render(result);
}

// ─── Red detection ───────────────────────────────────────────────────────────
function detectRed(imageData) {
  const { data, width, height } = imageData;
  const thr = cfg.threshold;

  let sumX = 0, sumY = 0, count = 0;
  let minX = width, maxX = 0, minY = height, maxY = 0;

  for (let y = 0; y < height; y += SAMPLE_STEP) {
    for (let x = 0; x < width; x += SAMPLE_STEP) {
      const i = (y * width + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];

      // 赤判定: R が強く、G・B が両方 90 未満、かつ G-B < 40（オレンジ除外）
      // 肌色は照明下でも G/B が 100 以上になるためここで弾かれる
      if (r > 160 && r - g > thr && r - b > thr && g < 90 && b < 90 && g - b < 40) {
        sumX  += x;
        sumY  += y;
        count++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  const area = count * SAMPLE_STEP * SAMPLE_STEP;

  if (area < cfg.minArea) {
    return { detected: false };
  }

  // ビデオ座標 → オーバーレイ座標に変換
  const scaleX = overlay.width  / imageData.width;
  const scaleY = overlay.height / imageData.height;

  // ミラー補正: video は CSS で scaleX(-1) しているため X を反転
  const rawCX = sumX / count;
  const rawCY = sumY / count;
  const cx = (imageData.width - rawCX) * scaleX;
  const cy = rawCY * scaleY;

  return {
    detected: true,
    cx, cy,
    area,
    bbox: {
      x: (imageData.width - maxX) * scaleX,
      y: minY * scaleY,
      w: (maxX - minX) * scaleX,
      h: (maxY - minY) * scaleY,
    },
  };
}

// ─── State update ─────────────────────────────────────────────────────────────
let prevX = null, prevY = null, prevT = null;

function updateState(result) {
  const now = performance.now();

  if (!result.detected) {
    wandState.isDetected = false;
    wandState.tipX = null;
    wandState.tipY = null;
    wandState.velocity = 0;
    prevX = prevY = prevT = null;
    setUndetected();
    return;
  }

  const { cx, cy, area } = result;

  // 速度計算
  let vel = 0;
  if (prevX !== null && prevT !== null) {
    const dt = (now - prevT) / 1000;  // seconds
    const dx = cx - prevX;
    const dy = cy - prevY;
    vel = Math.sqrt(dx * dx + dy * dy) / dt;
  }

  // 軌跡に追加
  wandState.trail.push({ x: cx, y: cy, t: now });
  if (wandState.trail.length > TRAIL_MAX_LEN) {
    wandState.trail.shift();
  }

  wandState.tipX      = cx;
  wandState.tipY      = cy;
  wandState.velocity  = vel;
  wandState.isDetected = true;

  prevX = cx; prevY = cy; prevT = now;

  // UI 更新
  badge.textContent = '検出中';
  badge.className   = 'badge detected';
  infoPos.textContent  = `${Math.round(cx)}, ${Math.round(cy)}`;
  infoVel.textContent  = `${Math.round(vel)} px/s`;
  infoArea.textContent = `${Math.round(area)} px²`;
}

function setUndetected() {
  badge.textContent = '未検出';
  badge.className   = 'badge undetected';
  infoPos.textContent  = '---';
  infoVel.textContent  = '---';
  infoArea.textContent = '---';
}

// ─── Render ──────────────────────────────────────────────────────────────────
function render(result) {
  ctx.clearRect(0, 0, overlay.width, overlay.height);

  // パーティクル・リングを常に更新（検出が切れても消えるまでアニメ継続）
  tickMagic();
  drawPulseRings();
  drawParticles();

  drawTrail();

  if (!result.detected) return;

  const { cx, cy, bbox } = result;

  // パーティクル生成
  spawnParticles(cx, cy, wandState.velocity);

  // 一定間隔でパルスリング
  if (pulseTimer++ % 10 === 0) {
    pulseRings.push({ x: cx, y: cy, r: 12, life: 1.0 });
  }

  // 速度が低いとき魔法陣を表示
  drawMagicCircle(cx, cy, wandState.velocity);

  // 検出範囲ボックス
  ctx.strokeStyle = 'rgba(255, 80, 100, 0.4)';
  ctx.lineWidth   = 1.5;
  ctx.setLineDash([6, 4]);
  ctx.strokeRect(bbox.x, bbox.y, bbox.w, bbox.h);
  ctx.setLineDash([]);

  drawGlowDot(cx, cy);
}

// ─── Magic: spawn ─────────────────────────────────────────────────────────────
function spawnParticles(x, y, vel) {
  const count = 8 + Math.min(Math.floor(vel / 40), 15);
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 2.5 + Math.random() * 4 + vel * 0.01;
    particles.push({
      x, y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 1.5,
      life: 1.0,
      decay: 0.012 + Math.random() * 0.018,
      size: 4 + Math.random() * 8,
      color: MAGIC_COLORS[Math.floor(Math.random() * MAGIC_COLORS.length)],
      isStar: Math.random() < 0.35,
    });
  }
}

// ─── Magic: tick (physics) ────────────────────────────────────────────────────
function tickMagic() {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x  += p.vx;
    p.y  += p.vy;
    p.vy += 0.09;
    p.life -= p.decay;
    if (p.life <= 0) particles.splice(i, 1);
  }
  for (let i = pulseRings.length - 1; i >= 0; i--) {
    const r = pulseRings[i];
    r.r    += 3.5;
    r.life -= 0.028;
    if (r.life <= 0) pulseRings.splice(i, 1);
  }
  circleAngle += 0.025;
}

// ─── Magic: draw pulse rings ──────────────────────────────────────────────────
function drawPulseRings() {
  for (const r of pulseRings) {
    ctx.beginPath();
    ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(200, 100, 255, ${r.life * 0.85})`;
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(r.x, r.y, r.r * 0.65, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255, 210, 80, ${r.life * 0.6})`;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

// ─── Magic: draw particles ────────────────────────────────────────────────────
function drawParticles() {
  for (const p of particles) {
    ctx.save();
    ctx.globalAlpha = p.life * 0.9;
    if (p.isStar) {
      drawStar(ctx, p.x, p.y, p.size * 2.5, p.color);
    } else {
      // コア（不透明）
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * 0.6, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      // グロー
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size * 2.5);
      g.addColorStop(0, p.color);
      g.addColorStop(0.5, p.color + 'aa');
      g.addColorStop(1, 'transparent');
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * 2.5, 0, Math.PI * 2);
      ctx.fillStyle = g;
      ctx.fill();
    }
    ctx.restore();
  }
}

function drawStar(ctx, x, y, r, color) {
  const pts = 4;
  ctx.beginPath();
  for (let i = 0; i < pts * 2; i++) {
    const a    = (i / (pts * 2)) * Math.PI * 2 - Math.PI / 2;
    const dist = i % 2 === 0 ? r : r * 0.35;
    const px = x + Math.cos(a) * dist;
    const py = y + Math.sin(a) * dist;
    i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

// ─── Magic: draw magic circle ─────────────────────────────────────────────────
function drawMagicCircle(x, y, vel) {
  ctx.save();
  ctx.globalAlpha = 0.85;
  ctx.translate(x, y);

  // 外輪
  ctx.beginPath();
  ctx.arc(0, 0, 60, 0, Math.PI * 2);
  ctx.strokeStyle = '#cc66ff';
  ctx.lineWidth = 2.5;
  ctx.stroke();

  // 内輪
  ctx.beginPath();
  ctx.arc(0, 0, 42, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(180, 80, 255, 0.8)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // 回転する放射線
  ctx.rotate(circleAngle);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * 12, Math.sin(a) * 12);
    ctx.lineTo(Math.cos(a) * 60, Math.sin(a) * 60);
    ctx.strokeStyle = 'rgba(200, 120, 255, 0.7)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // 逆回転の六角形
  ctx.rotate(-circleAngle * 2);
  ctx.beginPath();
  for (let i = 0; i <= 6; i++) {
    const a  = (i / 6) * Math.PI * 2;
    const px = Math.cos(a) * 42;
    const py = Math.sin(a) * 42;
    i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
  }
  ctx.strokeStyle = 'rgba(255, 210, 80, 0.8)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.restore();
}

function drawGlowDot(x, y) {
  // 外側グロー
  const grad = ctx.createRadialGradient(x, y, 0, x, y, 32);
  grad.addColorStop(0, 'rgba(255, 120, 140, 0.9)');
  grad.addColorStop(0.4, 'rgba(255, 40, 70, 0.5)');
  grad.addColorStop(1, 'rgba(255, 0, 40, 0)');
  ctx.beginPath();
  ctx.arc(x, y, 32, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();

  // コア
  ctx.beginPath();
  ctx.arc(x, y, 6, 0, Math.PI * 2);
  ctx.fillStyle = '#fff';
  ctx.fill();
}

function drawTrail() {
  const trail = wandState.trail;
  if (trail.length < 2) return;

  const now = performance.now();

  for (let i = 1; i < trail.length; i++) {
    const p0 = trail[i - 1];
    const p1 = trail[i];
    const age = now - p1.t;
    const alpha = Math.max(0, 1 - age / TRAIL_FADE_MS);

    if (alpha <= 0) continue;

    const frac = i / trail.length;  // 新しいほど太く明るく
    const width = frac * 6 + 1;

    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    ctx.lineTo(p1.x, p1.y);
    ctx.strokeStyle = `rgba(255, ${Math.round(80 + frac * 140)}, ${Math.round(100 + frac * 100)}, ${alpha * frac})`;
    ctx.lineWidth   = width;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';
    ctx.stroke();
  }

  // 軌跡の先端にグロー粒子
  if (trail.length > 0) {
    const last = trail[trail.length - 1];
    const age  = now - last.t;
    if (age < 200) {
      const a = 1 - age / 200;
      ctx.beginPath();
      ctx.arc(last.x, last.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255, 200, 200, ${a})`;
      ctx.fill();
    }
  }
}

// ─── Purge old trail entries periodically ────────────────────────────────────
setInterval(() => {
  const cutoff = performance.now() - TRAIL_FADE_MS;
  wandState.trail = wandState.trail.filter(p => p.t > cutoff);
}, 500);
