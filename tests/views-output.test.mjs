import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRESETS, presetView, customView, orbit, nudge, mirrorAngle, cameraDirection, perspectiveDistance, fixedScale,
  applyFitToMatrix, orthoPxPerMm, bookRadius, faceBrightness, normalizeDeg, PITCH_LIMIT, PERSPECTIVE_FOV, FIXED_MARGIN,
} from '../js/views.js';
import {
  neededPxPerMm, planFaceTexture, buildFileName, safeBaseName, analyzePixels, validateRender, MAX_PX_PER_MM,
} from '../js/output.js';
import { TRIM_SIZES } from '../js/crop-geometry.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

test('プリセットは6種（正面・表1＋背・表1＋小口・表4＋背・表4正面・斜め俯瞰）', () => {
  assert.deepEqual(PRESETS.map((p) => p.id), ['front', 'front-spine', 'front-edge', 'back-spine', 'back', 'overhead']);
  assert.throws(() => presetView('nope', 'left'));
});

test('背が見える角度: 左綴じは背=-X側、右綴じは+X側からカメラが見る', () => {
  for (const id of ['front-spine', 'back-spine', 'overhead']) {
    assert.ok(cameraDirection(presetView(id, 'left').yaw, 0)[0] < 0, `${id} 左綴じ`);
    assert.ok(cameraDirection(presetView(id, 'right').yaw, 0)[0] > 0, `${id} 右綴じ`);
  }
  const edge = cameraDirection(presetView('front-edge', 'left').yaw, 0);
  assert.ok(edge[0] > 0 && edge[2] > 0);
  assert.ok(cameraDirection(presetView('back', 'left').yaw, 0)[2] < -0.999);
});

test('正面・表4正面は正投影、自由角度は透視', () => {
  assert.equal(presetView('front', 'left').projection, 'ortho');
  assert.equal(presetView('back', 'right').projection, 'ortho');
  assert.equal(presetView('overhead', 'left').projection, 'perspective');
  assert.equal(customView({ yaw: 0, pitch: 0 }).projection, 'perspective');
});

test('ドラッグ: 右へで本が右に回る（カメラは左＝yaw減）、下へで見下ろす、仰角は上限で止まる', () => {
  const a = orbit({ yaw: 0, pitch: 0 }, 50, 0);
  assert.ok(a.yaw < 0);
  assert.ok(orbit({ yaw: 0, pitch: 0 }, 0, 40).pitch > 0);
  assert.equal(orbit({ yaw: 0, pitch: 0 }, 0, 100000).pitch, PITCH_LIMIT);
  assert.equal(orbit({ yaw: 0, pitch: 0 }, 0, -100000).pitch, -PITCH_LIMIT);
  assert.equal(nudge({ yaw: 179, pitch: 0 }, 3, 0).yaw, -178);
  assert.equal(normalizeDeg(212), -148);
  assert.equal(normalizeDeg(-180), 180);
  assert.ok(Object.is(normalizeDeg(-0), 0));
});

test('綴じ切替で自由角度を左右反転し、背の見える側を保つ', () => {
  const left = { yaw: -40, pitch: 10 };
  const right = mirrorAngle(left);
  assert.deepEqual(right, { yaw: 40, pitch: 10 });
  assert.ok(cameraDirection(left.yaw, 0)[0] < 0 && cameraDirection(right.yaw, 0)[0] > 0);
});

test('自由角度の出力名用ID', () => {
  assert.equal(customView({ yaw: -28.4, pitch: 12.6 }).id, 'custom-y-28p13');
});

// カメラ空間に移して透視/正投影の NDC を計算する（Three.js と同じ lookAt・up=+Y）
function projectNdc([x, y, z], yaw, pitch, projection, radius) {
  const d = cameraDirection(yaw, pitch);
  const fwd = d.map((v) => -v);
  const right = norm(cross(fwd, [0, 1, 0]));
  const up = cross(right, fwd);
  const dist = projection === 'ortho' ? radius * 3 : perspectiveDistance(radius);
  const rel = [x - d[0] * dist, y - d[1] * dist, z - d[2] * dist];
  const cx = dot(rel, right), cy = dot(rel, up), depth = dot(rel, fwd);
  const k = fixedScale(projection, radius, dist);
  if (projection === 'ortho') return [(cx / radius) * k, (cy / radius) * k];
  const t = Math.tan((PERSPECTIVE_FOV * Math.PI) / 360);
  return [(cx / depth / t) * k, (cy / depth / t) * k];
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(...a); return a.map((v) => v / l); };

test('固定縮尺: どの角度・判型・背幅でも本の8頂点が余白4%の内側に収まる', () => {
  const limit = 1 - FIXED_MARGIN * 2 + 1e-9;
  for (const trim of Object.values(TRIM_SIZES)) {
    for (const S of [0.1, 5, 16, 100]) {
      const { width: W, height: H } = trim;
      const r = bookRadius(W, H, S);
      const corners = [];
      for (const x of [-W / 2, W / 2]) for (const y of [-H / 2, H / 2]) for (const z of [-S / 2, S / 2]) corners.push([x, y, z]);
      for (let yaw = -180; yaw < 180; yaw += 15) {
        for (let pitch = -PITCH_LIMIT; pitch <= PITCH_LIMIT; pitch += 10) {
          for (const proj of ['ortho', 'perspective']) {
            for (const c of corners) {
              const [nx, ny] = projectNdc(c, yaw, pitch, proj, r);
              assert.ok(Math.abs(nx) <= limit && Math.abs(ny) <= limit, `${trim.key} S${S} ${proj} y${yaw} p${pitch}`);
            }
          }
        }
      }
    }
  }
});

test('固定縮尺: 角度を変えても縮尺は一定、正投影の正面は表1をmm比どおりに置く', () => {
  const r = bookRadius(148, 210, 16);
  const dist = perspectiveDistance(r);
  close(fixedScale('perspective', r, dist), fixedScale('perspective', r, dist));
  close(fixedScale('ortho', r, 0), 1 - FIXED_MARGIN * 2);
  const [, top] = projectNdc([0, 105, 8], 0, 0, 'ortho', r);
  close(top * 1000, orthoPxPerMm(2000, r) * 105, 1e-6);
});

test('射影行列への適用は NDC で k(x-c) と一致する（透視の w も考慮）', () => {
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
