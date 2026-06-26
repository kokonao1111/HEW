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
  threshold: 30,   // 赤の判定しきい値 (R - max(G,B) > threshold)
  minArea:   500,  // 最小検出面積 (px²)
};

const TRAIL_MAX_LEN = 60;
const TRAIL_FADE_MS = 1500;
const SAMPLE_STEP   = 3;   // ピクセル解析のサンプリング間隔 (重い場合は増やす)

// ─── State ───────────────────────────────────────────────────────────────────
let running    = false;
let rafId      = null;
let offscreen  = null;   // OffscreenCanvas (フレーム解析用)
let offCtx     = null;

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

      // 赤判定: R が高く、G/B より大幅に高い
      if (r > 100 && r - g > thr && r - b > thr) {
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
  drawTrail();

  if (!result.detected) return;

  const { cx, cy, bbox } = result;

  // 検出範囲ボックス
  ctx.strokeStyle = 'rgba(255, 80, 100, 0.6)';
  ctx.lineWidth   = 2;
  ctx.setLineDash([6, 4]);
  ctx.strokeRect(bbox.x, bbox.y, bbox.w, bbox.h);
  ctx.setLineDash([]);

  // 中心点 – 魔法っぽいグロー
  drawGlowDot(cx, cy);
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
