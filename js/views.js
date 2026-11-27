/*
SPDX-License-Identifier: Apache-2.0
Copyright 2026 ISHIKAWA, Natsuki
Project: edi-tool
Source: https://github.com/edi-tool
Applies to original code; third-party materials and separately licensed content retain their terms.
*/
// 角度プリセット・自由角度・縮尺（Three.jsに依存しない純粋関数）。
// 書籍は原点中心、表1=+Z、表4=-Z、左綴じの背=-X、右綴じの背=+X。
// yaw: カメラの水平角（0=表1の正面、+は小口側＝左綴じで+X）、pitch: 仰角（+は見下ろし）。

export const PRESETS = Object.freeze([
  { id: 'front', label: '正面（表1）', yaw: 0, pitch: 0, projection: 'ortho' },
  { id: 'front-spine', label: '表1＋背', yaw: -32, pitch: 6, projection: 'perspective' },
  { id: 'front-edge', label: '表1＋小口', yaw: 32, pitch: 6, projection: 'perspective' },
  { id: 'back-spine', label: '表4＋背', yaw: 212, pitch: 6, projection: 'perspective' },
  { id: 'back', label: '表4正面', yaw: 180, pitch: 0, projection: 'ortho' },
  { id: 'overhead', label: '斜め俯瞰', yaw: -36, pitch: 30, projection: 'perspective' },
].map(Object.freeze));

export const DEFAULT_PRESET = 'front-spine';
export const PERSPECTIVE_FOV = 20; // 望遠相当の画角（度）。歪みを抑える
export const FIXED_MARGIN = 0.04; // 本を囲む球が画像の各辺から4%内側に収まる縮尺
export const PITCH_LIMIT = 70;
export const DRAG_DEG_PER_PX = 0.4;

export function getPreset(id) {
  const preset = PRESETS.find((p) => p.id === id);
  if (!preset) throw new Error(`未対応の角度です: ${id}`);
  return preset;
}

// プリセットの角度。右綴じは背が+X側になるため水平角を左右反転する。
export function presetView(presetId, binding) {
  const p = getPreset(presetId);
  const mirror = binding === 'right' ? -1 : 1;
  return { id: p.id, yaw: normalizeDeg(p.yaw * mirror), pitch: p.pitch, projection: p.projection };
}

// ドラッグ量（CSS px）から角度を回す。右へドラッグで本が右へ回る（カメラは左へ）、下へドラッグで上から見る。
export function orbit(angle, dxPx, dyPx, degPerPx = DRAG_DEG_PER_PX) {
  return nudge(angle, -dxPx * degPerPx, dyPx * degPerPx * 0.75);
}

export function nudge(angle, dYaw, dPitch) {
  return {
    yaw: normalizeDeg(angle.yaw + dYaw),
    pitch: clamp(angle.pitch + dPitch, -PITCH_LIMIT, PITCH_LIMIT),
  };
}

// 綴じ方向を切り替えたとき、自由角度でも同じ側（背・小口）が見えるよう左右反転する
export function mirrorAngle(angle) {
  return { yaw: normalizeDeg(-angle.yaw), pitch: angle.pitch };
}

export function customView(angle) {
  const yaw = Math.round(angle.yaw);
  const pitch = Math.round(angle.pitch);
  return { id: `custom-y${yaw}p${pitch}`, yaw: angle.yaw, pitch: angle.pitch, projection: 'perspective' };
}

// 原点から見たカメラ方向の単位ベクトル
export function cameraDirection(yawDeg, pitchDeg) {
  const yaw = (yawDeg * Math.PI) / 180;
  const pitch = (pitchDeg * Math.PI) / 180;
  return [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
}

// 透視カメラの距離。本を囲む球（半径 radius）が画角に余裕をもって入る距離
export function perspectiveDistance(radius, fovDeg = PERSPECTIVE_FOV) {
  return (radius / Math.sin((fovDeg * Math.PI) / 360)) * 1.05;
}

// 角度によらず同じ縮尺にする倍率。本を囲む球の見かけの大きさが NDC の 1 - 2*margin に収まる。
// 正投影の視体積は ±radius、透視は距離 distance・画角 fov を前提にする。
export function fixedScale(projection, radius, distance, fovDeg = PERSPECTIVE_FOV, margin = FIXED_MARGIN) {
  const target = 1 - margin * 2;
  if (projection === 'ortho') return target;
  const silhouette = Math.tan(Math.asin(radius / distance)) / Math.tan((fovDeg * Math.PI) / 360);
  return target / silhouette;
}

// 列優先4x4射影行列に NDC' = k * (NDC - c) を掛ける（クリップ空間で x' = k(x - cx·w)）。
export function applyFitToMatrix(elements, fit) {
  const e = elements.slice();
  for (let col = 0; col < 4; col++) {
    const w = e[col * 4 + 3];
    e[col * 4 + 0] = fit.k * (e[col * 4 + 0] - fit.cx * w);
    e[col * 4 + 1] = fit.k * (e[col * 4 + 1] - fit.cy * w);
  }
  return e;
}

// 正面（正投影）での 1mm あたりの画素数。WebGL2 が無いときの平面描画も同じ大きさにする。
export function orthoPxPerMm(sizePx, radius, margin = FIXED_MARGIN) {
  return (sizePx / 2) * (1 - margin * 2) / radius;
}

export function bookRadius(W, H, S) {
  return Math.hypot(W, H, S) / 2;
}

// カメラに対する固定の光で面の明るさを決める。カメラ正面を向く面はちょうど1（元絵の色）。
export function faceBrightness(normal, camDir, camUp, camRight, ambient = 0.58) {
  const light = normalize3(add3(camDir, add3(scale3(camUp, 0.45), scale3(camRight, -0.3))));
  const ref = dot3(camDir, light);
  const d = Math.max(0, dot3(normal, light));
  return Math.min(1, ambient + (1 - ambient) * (d / ref));
}

export function normalizeDeg(deg) {
  let d = ((deg + 180) % 360 + 360) % 360 - 180;
  if (d === -180) d = 180;
  if (Object.is(d, -0)) d = 0;
  return d;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function add3(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function scale3(a, k) { return [a[0] * k, a[1] * k, a[2] * k]; }
function normalize3(a) { const l = Math.hypot(a[0], a[1], a[2]); return [a[0] / l, a[1] / l, a[2] / l]; }
