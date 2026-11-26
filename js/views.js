// 角度プリセットと構図合わせ（Three.jsに依存しない純粋関数）。
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
export const ADJUST_RANGE = Object.freeze({ yaw: 45, pitch: 30 });
export const PERSPECTIVE_FOV = 20; // 望遠相当の画角（度）。歪みを抑える
export const FIT_MARGIN = 0.08; // 画像の各辺の余白（割合）

export function getPreset(id) {
  const preset = PRESETS.find((p) => p.id === id);
  if (!preset) throw new Error(`未対応の角度です: ${id}`);
  return preset;
}

// 右綴じは背が+X側になるため水平角を左右反転する。微調整（adjust）も反転後の向きで加える。
export function resolveView(presetId, binding, adjust = { yaw: 0, pitch: 0 }) {
  const preset = getPreset(presetId);
  const mirror = binding === 'right' ? -1 : 1;
  const yaw = normalizeDeg(preset.yaw * mirror + clamp(adjust.yaw || 0, -ADJUST_RANGE.yaw, ADJUST_RANGE.yaw) * mirror);
  const pitch = clamp(preset.pitch + clamp(adjust.pitch || 0, -ADJUST_RANGE.pitch, ADJUST_RANGE.pitch), -80, 80);
  const adjusted = Boolean(adjust.yaw || adjust.pitch);
  // 正面・表4正面は正投影で表紙を歪ませない。微調整したら透視にする。
  const projection = preset.projection === 'ortho' && !adjusted ? 'ortho' : 'perspective';
  return { id: preset.id, yaw, pitch, projection };
}

// 原点から見たカメラ方向の単位ベクトル
export function cameraDirection(yawDeg, pitchDeg) {
  const yaw = (yawDeg * Math.PI) / 180;
  const pitch = (pitchDeg * Math.PI) / 180;
  return [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
}

// 直方体の8頂点
export function boxCorners(w, h, d) {
  const out = [];
  for (const x of [-w / 2, w / 2]) for (const y of [-h / 2, h / 2]) for (const z of [-d / 2, d / 2]) out.push([x, y, z]);
  return out;
}

// 正規化デバイス座標の点群を、余白を残して正方形の中央に収める変換 NDC' = k * (NDC - c)
export function fitTransform(ndcPoints, margin = FIT_MARGIN) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of ndcPoints) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('投影できない頂点があります。');
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const half = Math.max(maxX - minX, maxY - minY) / 2;
  if (!(half > 0)) throw new Error('構図を計算できません。');
  const target = 1 - margin * 2;
  return { k: target / half, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}

// 列優先4x4射影行列に fitTransform を掛ける（クリップ空間で x' = k(x - cx·w)）。
export function applyFitToMatrix(elements, fit) {
  const e = elements.slice();
  for (let col = 0; col < 4; col++) {
    const w = e[col * 4 + 3];
    e[col * 4 + 0] = fit.k * (e[col * 4 + 0] - fit.cx * w);
    e[col * 4 + 1] = fit.k * (e[col * 4 + 1] - fit.cy * w);
  }
  return e;
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
  return d;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function add3(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function scale3(a, k) { return [a[0] * k, a[1] * k, a[2] * k]; }
function normalize3(a) { const l = Math.hypot(a[0], a[1], a[2]); return [a[0] / l, a[1] / l, a[2] / l]; }
