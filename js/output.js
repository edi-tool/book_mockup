// 出力サイズ・テクスチャ解像度・ファイル名・空画像判定（DOMに依存しない純粋関数）。

export const OUTPUT_SIZES = Object.freeze([1200, 2000, 3000]);
export const DEFAULT_OUTPUT_SIZE = 2000;
export const MAX_FACE_PIXELS = 16_000_000; // 1面あたりのcanvas上限（暫定16MP）
export const MAX_PX_PER_MM = 400 / 25.4; // 400ppi相当を上限にする
export const MIN_PX_PER_MM = 2;

// 出力画像の一辺 px から、面テクスチャに必要な px/mm を求める。
// 本の長辺が画像の (1 - 2*余白) を占め、斜め・透視での拡大分として1.25倍の余裕を持たせる。
export function neededPxPerMm(outputPx, bookLongSideMm, margin = 0.08) {
  const px = (outputPx * (1 - margin * 2) * 1.25) / bookLongSideMm;
  return Math.min(MAX_PX_PER_MM, Math.max(MIN_PX_PER_MM, px));
}

// 面ごとのテクスチャ寸法を、テクスチャ上限・面積上限に収める。reduced は縮小したかどうか。
export function planFaceTexture(faceWmm, faceHmm, pxPerMm, maxTextureSize, maxPixels = MAX_FACE_PIXELS) {
  let s = pxPerMm;
  const limitBySide = maxTextureSize / Math.max(faceWmm, faceHmm);
  const limitByArea = Math.sqrt(maxPixels / (faceWmm * faceHmm));
  const limit = Math.min(limitBySide, limitByArea);
  const reduced = s > limit;
  if (reduced) s = limit;
  const width = Math.max(1, Math.min(maxTextureSize, Math.round(faceWmm * s)));
  const height = Math.max(1, Math.min(maxTextureSize, Math.round(faceHmm * s)));
  return { width, height, pxPerMm: s, ppi: s * 25.4, reduced };
}

const INVALID_FILENAME = /[<>:"/\\|?*\u0000-\u001F\u007F-\u009F]/g;
const RESERVED = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

export function safeBaseName(name) {
  let base = typeof name === 'string' ? name : '';
  base = base.replace(/\.pdf$/i, '').replace(INVALID_FILENAME, '_').replace(/\s+/g, ' ').trim();
  base = base.replace(/^[. ]+|[. ]+$/g, '');
  if (RESERVED.test(base)) base = `_${base}`;
  base = Array.from(base).slice(0, 60).join('');
  return base || 'cover';
}

// 例: 表紙_mockup_front-spine_A5_背16mm_2000px.png
export function buildFileName({ sourceName, presetId, trimLabel, spineMm, sizePx }) {
  const spine = Number.isInteger(spineMm) ? String(spineMm) : spineMm.toFixed(1);
  return `${safeBaseName(sourceName)}_mockup_${presetId}_${trimLabel}_背${spine}mm_${sizePx}px.png`;
}

// RGBAの画素列から、不透明画素と「白以外」の画素を数える（間引きあり）。
export function analyzePixels(data, width, height, step = 4) {
  let sampled = 0, opaque = 0, nonWhite = 0;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      sampled++;
      const a = data[i + 3];
      if (a > 8) {
        opaque++;
        if (data[i] < 245 || data[i + 1] < 245 || data[i + 2] < 245) nonWhite++;
      }
    }
  }
  return { sampled, opaque, nonWhite };
}

// 空（全透明）や真っ白な画像を成功扱いしない
export function validateRender(stats) {
  if (stats.opaque === 0) return { ok: false, error: '描画結果が空でした。もう一度お試しください。' };
  if (stats.nonWhite === 0) return { ok: false, error: '描画結果が白一色でした。範囲とPDFを確認してください。' };
  return { ok: true };
}
