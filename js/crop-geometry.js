/*
SPDX-License-Identifier: Apache-2.0
Copyright 2026 ISHIKAWA, Natsuki
Project: edi-tool
Source: https://github.com/edi-tool
Applies to original code; third-party materials and separately licensed content retain their terms.
*/
// 判型・背幅・仕上がり枠の計算（DOM・PDF.jsに依存しない純粋関数）。
// 座標の単位は PDF.js の page.getViewport({ scale: 1, rotation }) の値（UserUnit込みのpt、左上原点）。

export const MM_PER_PT = 25.4 / 72;
export const PT_PER_MM = 72 / 25.4;

export const TRIM_SIZES = Object.freeze({
  B5: Object.freeze({ key: 'B5', label: 'B5', width: 182, height: 257 }),
  A5: Object.freeze({ key: 'A5', label: 'A5', width: 148, height: 210 }),
  shiroku: Object.freeze({ key: 'shiroku', label: '四六', width: 127, height: 188 }),
});

export const SPINE_RANGE = Object.freeze({ min: 0.1, max: 100, step: 0.1 });
export const BINDINGS = Object.freeze(['left', 'right']);
export const FACE_LABELS = Object.freeze({ front: '表1', spine: '背', back: '表4' });

export function getTrim(trimKey) {
  const trim = TRIM_SIZES[trimKey];
  if (!trim) throw new Error(`未対応の判型です: ${trimKey}`);
  return trim;
}

// 背幅の入力値を検証する。全角数字・全角ピリオドも受け付ける。
export function parseSpineMm(input) {
  if (input === null || input === undefined) return { ok: false, error: '背幅を入力してください。' };
  const text = String(input)
    .trim()
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[．。]/g, '.')
    .replace(/\s*(mm|ｍｍ)$/i, '');
  if (text === '') return { ok: false, error: '背幅を入力してください。' };
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(text)) return { ok: false, error: '背幅は数値（mm）で入力してください。' };
  const value = Number(text);
  if (!Number.isFinite(value)) return { ok: false, error: '背幅は数値（mm）で入力してください。' };
  if (value <= 0) return { ok: false, error: '背幅は0より大きい値にしてください。' };
  if (value < SPINE_RANGE.min || value > SPINE_RANGE.max) {
    return { ok: false, error: `背幅は${SPINE_RANGE.min}〜${SPINE_RANGE.max}mmの範囲で入力してください。` };
  }
  const tenths = value * 10;
  if (Math.abs(tenths - Math.round(tenths)) > 1e-6) {
    return { ok: false, error: '背幅は0.1mm単位で入力してください。' };
  }
  return { ok: true, value: Math.round(tenths) / 10 };
}

// 展開サイズ（表4＋背＋表1）の仕上がり寸法 mm
export function spreadSizeMm(trimKey, spineMm) {
  const trim = getTrim(trimKey);
  return {
    width: round6(trim.width * 2 + spineMm),
    height: trim.height,
    faceWidth: trim.width,
    spine: spineMm,
  };
}

// 左綴じは左から表4・背・表1、右綴じは逆。
export function faceOrder(binding) {
  if (binding === 'left') return ['back', 'spine', 'front'];
  if (binding === 'right') return ['front', 'spine', 'back'];
  throw new Error(`未対応の綴じ方向です: ${binding}`);
}

// 枠の幅に対する各面の幅の割合（左から順）
export function faceFractions(trimKey, spineMm) {
  const { width, faceWidth, spine } = spreadSizeMm(trimKey, spineMm);
  return [faceWidth / width, spine / width, faceWidth / width];
}

// 枠の横方向の境界 [左端, 境界1, 境界2, 右端]
export function boundaryXs(rect, trimKey, spineMm) {
  const [a, b] = faceFractions(trimKey, spineMm);
  return [rect.x, rect.x + rect.w * a, rect.x + rect.w * (a + b), rect.x + rect.w];
}

// 枠から各面の矩形を求める。戻り値は { front, spine, back }。
export function faceRects(rect, trimKey, spineMm, binding) {
  const xs = boundaryXs(rect, trimKey, spineMm);
  const order = faceOrder(binding);
  const out = {};
  order.forEach((face, i) => {
    out[face] = { x: xs[i], y: rect.y, w: xs[i + 1] - xs[i], h: rect.h };
  });
  return out;
}

// 整数画素へ丸めるときは累積境界を丸め、面の間に隙間や重なりを作らない。
export function pixelEdges(startPx, lengthPx, fractions) {
  const edges = [Math.round(startPx)];
  let acc = 0;
  for (let i = 0; i < fractions.length; i++) {
    acc += fractions[i];
    edges.push(i === fractions.length - 1 ? Math.round(startPx + lengthPx) : Math.round(startPx + lengthPx * acc));
  }
  return edges;
}

// 枠の縦横比（高さ / 幅）
export function rectAspect(trimKey, spineMm) {
  const { width, height } = spreadSizeMm(trimKey, spineMm);
  return height / width;
}

// PDF実寸で枠を作り、ページ中央に置く。ページより大きいときは収まるよう縮める（fitted: true）。
export function initialRect(pageW, pageH, trimKey, spineMm) {
  const { width, height } = spreadSizeMm(trimKey, spineMm);
  let w = width * PT_PER_MM;
  let h = height * PT_PER_MM;
  let fitted = false;
  if (w > pageW || h > pageH) {
    const k = Math.min(pageW / w, pageH / h) * 0.95;
    w *= k;
    h *= k;
    fitted = true;
  }
  return { rect: { x: (pageW - w) / 2, y: (pageH - h) / 2, w, h }, fitted };
}

// 枠をページ内に収める。大きすぎる場合は縦横比を保って縮める。
export function clampRect(rect, pageW, pageH) {
  let { x, y, w, h } = rect;
  if (w > pageW || h > pageH) {
    const k = Math.min(pageW / w, pageH / h);
    const cx = x + w / 2;
    const cy = y + h / 2;
    w *= k;
    h *= k;
    x = cx - w / 2;
    y = cy - h / 2;
  }
  x = Math.min(Math.max(x, 0), pageW - w);
  y = Math.min(Math.max(y, 0), pageH - h);
  return { x, y, w, h };
}

// Shift を押しながらの移動: 移動量の大きい方の軸だけに固定する（水平 or 垂直）
export function lockAxis(dx, dy) {
  return Math.abs(dx) >= Math.abs(dy) ? { dx, dy: 0, axis: 'x' } : { dx: 0, dy, axis: 'y' };
}

export function moveRect(rect, dx, dy, pageW, pageH) {
  return clampRect({ ...rect, x: rect.x + dx, y: rect.y + dy }, pageW, pageH);
}

// 幅を指定して均等拡縮する。anchor は固定する点（ページ座標）。
export function resizeRect(rect, newW, aspect, anchor, pageW, pageH, minW = 10) {
  let w = Math.max(minW, newW);
  let h = w * aspect;
  const limit = maxSizeAround(anchor, rect, pageW, pageH, aspect);
  if (w > limit) {
    w = limit;
    h = w * aspect;
  }
  const ax = anchor.fx; // 0=左, 0.5=中央, 1=右
  const ay = anchor.fy;
  const x = anchor.x - w * ax;
  const y = anchor.y - h * ay;
  return clampRect({ x, y, w, h }, pageW, pageH);
}

function maxSizeAround(anchor, rect, pageW, pageH, aspect) {
  const room = (pos, frac, size) => {
    const before = frac > 0 ? pos / frac : Infinity;
    const after = frac < 1 ? (size - pos) / (1 - frac) : Infinity;
    return Math.min(before, after);
  };
  const wByX = room(anchor.x, anchor.fx, pageW);
  const wByY = room(anchor.y, anchor.fy, pageH) / aspect;
  return Math.max(1, Math.min(wByX, wByY));
}

export function scaleRectAroundCenter(rect, factor, aspect, pageW, pageH) {
  const anchor = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2, fx: 0.5, fy: 0.5 };
  return resizeRect(rect, rect.w * factor, aspect, anchor, pageW, pageH);
}

export function rectSizeMm(rect) {
  return { width: rect.w * MM_PER_PT, height: rect.h * MM_PER_PT };
}

// 枠の実寸と指定寸法との差（割合）。0.01 = 1%
export function sizeDeviation(rect, trimKey, spineMm) {
  const { width } = spreadSizeMm(trimKey, spineMm);
  return rect.w * MM_PER_PT / width - 1;
}

// 判型・背幅を変えたとき、枠の中心と高さを保って比率だけ合わせる。
export function refitRect(rect, trimKey, spineMm, pageW, pageH) {
  const aspect = rectAspect(trimKey, spineMm);
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const h = rect.h;
  const w = h / aspect;
  return clampRect({ x: cx - w / 2, y: cy - h / 2, w, h }, pageW, pageH);
}

export function toNormalized(rect, pageW, pageH) {
  return { x: rect.x / pageW, y: rect.y / pageH, w: rect.w / pageW, h: rect.h / pageH };
}

export function fromNormalized(n, pageW, pageH) {
  return { x: n.x * pageW, y: n.y * pageH, w: n.w * pageW, h: n.h * pageH };
}

// 表示座標（CSS px）とページ座標の相互変換。view = { scale, originX, originY }
export function pageToView(view, px, py) {
  return { x: (px - view.originX) * view.scale, y: (py - view.originY) * view.scale };
}

export function viewToPage(view, vx, vy) {
  return { x: vx / view.scale + view.originX, y: vy / view.scale + view.originY };
}

// 表示領域にページ全体を収める表示変換
export function fitView(pageW, pageH, viewW, viewH, padding = 16) {
  const scale = Math.max(1e-6, Math.min((viewW - padding * 2) / pageW, (viewH - padding * 2) / pageH));
  return {
    scale,
    originX: pageW / 2 - viewW / 2 / scale,
    originY: pageH / 2 - viewH / 2 / scale,
  };
}

// 表示点 (vx, vy) を固定して拡大縮小する
export function zoomViewAt(view, factor, vx, vy, minScale = 0.02, maxScale = 80) {
  const scale = Math.min(maxScale, Math.max(minScale, view.scale * factor));
  const p = viewToPage(view, vx, vy);
  return { scale, originX: p.x - vx / scale, originY: p.y - vy / scale };
}

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}
