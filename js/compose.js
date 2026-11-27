/*
SPDX-License-Identifier: Apache-2.0
Copyright 2026 ISHIKAWA, Natsuki
Project: edi-tool
Source: https://github.com/edi-tool
Applies to original code; third-party materials and separately licensed content retain their terms.
*/
// 3D描画結果に影と背景を重ねる（Canvas 2D）。影は本のシルエットから作る別レイヤー。
// ctx.filter（Safari 18未満は非対応）を使わず、縮小→拡大でぼかして全ブラウザで同じ結果にする。

export function createCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export function releaseCanvas(c) {
  if (c) {
    c.width = 0;
    c.height = 0;
  }
}

function blurredSilhouette(source, size, radiusRatio) {
  const sil = createCanvas(size, size);
  const sctx = sil.getContext('2d');
  sctx.drawImage(source, 0, 0, size, size);
  sctx.globalCompositeOperation = 'source-in';
  sctx.fillStyle = '#000';
  sctx.fillRect(0, 0, size, size);
  // 段階的に縮小してから拡大するとガウスぼかしに近くなる
  let current = sil;
  let s = size;
  const target = Math.max(4, Math.round(size * radiusRatio));
  const steps = [];
  while (s / 2 >= target) {
    s = Math.round(s / 2);
    const next = createCanvas(s, s);
    const ctx = next.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(current, 0, 0, s, s);
    steps.push(next);
    current = next;
  }
  for (let i = steps.length - 2; i >= 0; i--) {
    const ctx = steps[i].getContext('2d');
    ctx.clearRect(0, 0, steps[i].width, steps[i].height);
    ctx.drawImage(current, 0, 0, steps[i].width, steps[i].height);
    current = steps[i];
  }
  const out = createCanvas(size, size);
  const octx = out.getContext('2d');
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(current, 0, 0, size, size);
  releaseCanvas(sil);
  steps.forEach(releaseCanvas);
  return out;
}

// source: 透明背景の本の描画（正方形）。background: 'transparent' | 'white'
export function composeMockup(source, size, { background = 'transparent', shadow = true } = {}) {
  const out = createCanvas(size, size);
  const ctx = out.getContext('2d');
  if (background === 'white') {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, size, size);
  }
  if (shadow) {
    const soft = blurredSilhouette(source, size, 1 / 48);
    ctx.globalAlpha = 0.22;
    ctx.drawImage(soft, size * 0.012, size * 0.02);
    releaseCanvas(soft);
    const contact = blurredSilhouette(source, size, 1 / 220);
    ctx.globalAlpha = 0.2;
    ctx.drawImage(contact, size * 0.002, size * 0.005);
    releaseCanvas(contact);
    ctx.globalAlpha = 1;
  }
  ctx.drawImage(source, 0, 0, size, size);
  return out;
}

export function canvasToBlob(canvas, type = 'image/png') {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('PNGの作成に失敗しました。'))), type);
  });
}
