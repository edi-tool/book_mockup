import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRESETS, resolveView, cameraDirection, boxCorners, fitTransform, applyFitToMatrix, faceBrightness, normalizeDeg,
} from '../js/views.js';
import {
  neededPxPerMm, planFaceTexture, buildFileName, safeBaseName, analyzePixels, validateRender, MAX_PX_PER_MM,
} from '../js/output.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

test('プリセットは6種（正面・表1＋背・表1＋小口・表4＋背・表4正面・斜め俯瞰）', () => {
  assert.deepEqual(PRESETS.map((p) => p.id), ['front', 'front-spine', 'front-edge', 'back-spine', 'back', 'overhead']);
});

test('背が見える角度: 左綴じは背=-X側、右綴じは+X側からカメラが見る', () => {
  for (const id of ['front-spine', 'back-spine', 'overhead']) {
    const l = cameraDirection(resolveView(id, 'left').yaw, 0);
    const r = cameraDirection(resolveView(id, 'right').yaw, 0);
    assert.ok(l[0] < 0, `${id} 左綴じ`);
    assert.ok(r[0] > 0, `${id} 右綴じ`);
  }
  const edge = cameraDirection(resolveView('front-edge', 'left').yaw, 0);
  assert.ok(edge[0] > 0 && edge[2] > 0);
  const back = cameraDirection(resolveView('back', 'left').yaw, 0);
  assert.ok(back[2] < -0.999);
});

test('正面・表4正面は正投影、微調整すると透視', () => {
  assert.equal(resolveView('front', 'left').projection, 'ortho');
  assert.equal(resolveView('back', 'right').projection, 'ortho');
  assert.equal(resolveView('front', 'left', { yaw: 5, pitch: 0 }).projection, 'perspective');
  assert.equal(resolveView('overhead', 'left').projection, 'perspective');
  assert.throws(() => resolveView('nope', 'left'));
});

test('微調整は範囲内に制限される', () => {
  const v = resolveView('front', 'left', { yaw: 999, pitch: -999 });
  assert.equal(v.yaw, 45);
  assert.equal(v.pitch, -30);
  assert.equal(normalizeDeg(212), -148);
  assert.equal(normalizeDeg(-180), 180);
});

test('構図合わせ: 点群が余白8%で中央に来る', () => {
  const pts = [[-0.2, 0.1], [0.5, 0.9], [0.1, -0.3]];
  const fit = fitTransform(pts, 0.08);
  const mapped = pts.map(([x, y]) => [fit.k * (x - fit.cx), fit.k * (y - fit.cy)]);
  const xs = mapped.map((p) => p[0]);
  const ys = mapped.map((p) => p[1]);
  close(Math.max(...ys), 0.84);
  close(Math.min(...ys), -0.84);
  close((Math.max(...xs) + Math.min(...xs)) / 2, 0);
  assert.throws(() => fitTransform([[0, 0], [0, 0]]));
  assert.throws(() => fitTransform([[NaN, 0], [1, 1]]));
});

test('射影行列への適用は NDC で k(x-c) と一致する（透視の w も考慮）', () => {
  // 適当な透視行列（列優先）
  const f = 1 / Math.tan(Math.PI / 18);
  const m = [f, 0, 0, 0, 0, f, 0, 0, 0, 0, -1.01, -1, 0, 0, -0.2, 0];
  const fit = { k: 1.7, cx: 0.12, cy: -0.3 };
  const m2 = applyFitToMatrix(m, fit);
  const mul = (e, [x, y, z]) => [
    e[0] * x + e[4] * y + e[8] * z + e[12],
    e[1] * x + e[5] * y + e[9] * z + e[13],
    e[2] * x + e[6] * y + e[10] * z + e[14],
    e[3] * x + e[7] * y + e[11] * z + e[15],
  ];
  for (const p of [[1, 2, -10], [-3, 0.5, -20]]) {
    const a = mul(m, p);
    const b = mul(m2, p);
    close(b[0] / b[3], fit.k * (a[0] / a[3] - fit.cx), 1e-12);
    close(b[1] / b[3], fit.k * (a[1] / a[3] - fit.cy), 1e-12);
  }
  assert.equal(boxCorners(2, 3, 4).length, 8);
});

test('面の明るさ: カメラ正面の面はちょうど1、背けた面は暗い', () => {
  const dir = [0, 0, 1], up = [0, 1, 0], right = [1, 0, 0];
  close(faceBrightness([0, 0, 1], dir, up, right), 1);
  assert.ok(faceBrightness([-1, 0, 0], dir, up, right) < 1);
  assert.ok(faceBrightness([0, 0, -1], dir, up, right) >= 0.5);
});

test('テクスチャ解像度: 出力サイズに比例し、上限で縮小を報告', () => {
  assert.ok(neededPxPerMm(3000, 257) > neededPxPerMm(1200, 257));
  assert.equal(neededPxPerMm(100000, 100), MAX_PX_PER_MM);
  const ok = planFaceTexture(148, 210, 10, 8192);
  assert.deepEqual([ok.width, ok.height, ok.reduced], [1480, 2100, false]);
  const lim = planFaceTexture(182, 257, 15, 2048);
  assert.equal(lim.reduced, true);
  assert.ok(lim.height <= 2048);
  const area = planFaceTexture(182, 257, 30, 16384, 4_000_000);
  assert.ok(area.width * area.height <= 4_000_000 * 1.01);
  const spine = planFaceTexture(0.1, 257, 15.7, 4096);
  assert.ok(spine.width >= 1);
});

test('ファイル名: 拡張子除去・禁止文字置換・予約名回避・角度/判型/背幅/サイズ入り', () => {
  assert.equal(
    buildFileName({ sourceName: 'カバー入稿.pdf', presetId: 'front-spine', trimLabel: 'A5', spineMm: 16, sizePx: 2000 }),
    'カバー入稿_mockup_front-spine_A5_背16mm_2000px.png',
  );
  assert.equal(buildFileName({ sourceName: 'a', presetId: 'front', trimLabel: '四六', spineMm: 10.5, sizePx: 1200 }), 'a_mockup_front_四六_背10.5mm_1200px.png');
  assert.equal(safeBaseName('a/b:c*?.PDF'), 'a_b_c__');
  assert.equal(safeBaseName('CON.pdf'), '_CON');
  assert.equal(safeBaseName('...'), 'cover');
  assert.equal(Array.from(safeBaseName('あ'.repeat(100))).length, 60);
});

test('空・白一色の画像は失敗扱い', () => {
  const w = 8, h = 8;
  const empty = new Uint8ClampedArray(w * h * 4);
  assert.equal(validateRender(analyzePixels(empty, w, h, 1)).ok, false);
  const white = new Uint8ClampedArray(w * h * 4).fill(255);
  assert.equal(validateRender(analyzePixels(white, w, h, 1)).ok, false);
  const some = white.slice();
  some.set([10, 20, 30, 255], (3 * w + 3) * 4);
  assert.equal(validateRender(analyzePixels(some, w, h, 1)).ok, true);
});
