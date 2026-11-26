import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PT_PER_MM, MM_PER_PT, TRIM_SIZES, parseSpineMm, spreadSizeMm, faceOrder, faceRects, boundaryXs, pixelEdges,
  initialRect, clampRect, moveRect, resizeRect, scaleRectAroundCenter, rectAspect, sizeDeviation, refitRect,
  toNormalized, fromNormalized, pageToView, viewToPage, fitView, zoomViewAt, faceFractions, lockAxis,
} from '../js/crop-geometry.js';
import { coverLayout } from '../scripts/make-test-pdf.mjs';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

test('判型の指定値', () => {
  assert.deepEqual([TRIM_SIZES.B5.width, TRIM_SIZES.B5.height], [182, 257]);
  assert.deepEqual([TRIM_SIZES.A5.width, TRIM_SIZES.A5.height], [148, 210]);
  assert.deepEqual([TRIM_SIZES.shiroku.width, TRIM_SIZES.shiroku.height], [127, 188]);
});

test('展開寸法 A5/16=312×210, B5/5=369×257, 四六/16=270×188', () => {
  assert.deepEqual([spreadSizeMm('A5', 16).width, spreadSizeMm('A5', 16).height], [312, 210]);
  assert.deepEqual([spreadSizeMm('B5', 5).width, spreadSizeMm('B5', 5).height], [369, 257]);
  assert.deepEqual([spreadSizeMm('shiroku', 16).width, spreadSizeMm('shiroku', 16).height], [270, 188]);
  assert.equal(spreadSizeMm('A5', 10.5).width, 306.5);
});

test('背幅の検証: 空/0/負/非有限/範囲外/刻み違反はエラー、全角は受け付ける', () => {
  for (const bad of ['', '  ', null, undefined, '0', '-3', 'abc', 'Infinity', 'NaN', '0.05', '100.1', '16.25', '1e3']) {
    assert.equal(parseSpineMm(bad).ok, false, `「${bad}」はエラーのはず`);
  }
  assert.deepEqual(parseSpineMm('16'), { ok: true, value: 16 });
  assert.deepEqual(parseSpineMm('１６．５'), { ok: true, value: 16.5 });
  assert.deepEqual(parseSpineMm('5mm'), { ok: true, value: 5 });
  assert.deepEqual(parseSpineMm('0.1'), { ok: true, value: 0.1 });
  assert.deepEqual(parseSpineMm('100'), { ok: true, value: 100 });
  assert.deepEqual(parseSpineMm(0.3), { ok: true, value: 0.3 });
});

for (const trim of ['B5', 'A5', 'shiroku']) {
  for (const spine of [5, 16]) {
    for (const binding of ['left', 'right']) {
      test(`面境界 ${trim}/背${spine}/${binding}: 合成PDFの面位置と一致`, () => {
        const L = coverLayout({ trim, spine, binding });
        const rect = { x: L.spread.x * PT_PER_MM, y: L.spread.y * PT_PER_MM, w: L.spread.w * PT_PER_MM, h: L.spread.h * PT_PER_MM };
        close(rect.h / rect.w, rectAspect(trim, spine));
        const faces = faceRects(rect, trim, spine, binding);
        for (const face of ['front', 'spine', 'back']) {
          close(faces[face].x * MM_PER_PT, L.faces[face].x, 1e-9);
          close(faces[face].w * MM_PER_PT, L.faces[face].w, 1e-9);
        }
        const order = faceOrder(binding);
        assert.ok(faces[order[0]].x < faces[order[1]].x && faces[order[1]].x < faces[order[2]].x);
      });
    }
  }
}

test('綴じ方向で面の並びが逆になる', () => {
  assert.deepEqual(faceOrder('left'), ['back', 'spine', 'front']);
  assert.deepEqual(faceOrder('right'), ['front', 'spine', 'back']);
  assert.throws(() => faceOrder('top'));
});

test('境界は x, x+w*W/(2W+S), x+w*(W+S)/(2W+S), x+w', () => {
  const r = { x: 10, y: 0, w: 312, h: 210 };
  const xs = boundaryXs(r, 'A5', 16);
  close(xs[1], 10 + 312 * 148 / 312);
  close(xs[2], 10 + 312 * 164 / 312);
  close(xs[3], 322);
});

test('整数画素の丸めで隙間・重なりができない（背5mmでも）', () => {
  for (const [trim, spine] of [['A5', 5], ['B5', 0.1], ['shiroku', 16]]) {
    const f = faceFractions(trim, spine);
    for (const start of [0, 0.4, 13.7]) {
      for (const len of [100, 999.5, 3517.3]) {
        const e = pixelEdges(start, len, f);
        assert.equal(e.length, 4);
        for (let i = 1; i < e.length; i++) assert.ok(e[i] >= e[i - 1]);
        assert.equal(e[0], Math.round(start));
        assert.equal(e[3], Math.round(start + len));
        const widths = [e[1] - e[0], e[2] - e[1], e[3] - e[2]];
        assert.equal(widths.reduce((a, b) => a + b, 0), e[3] - e[0]);
      }
    }
  }
});

test('初期枠は実寸で中央配置、ページより大きいときは縮める', () => {
  const pageW = 600 * PT_PER_MM, pageH = 300 * PT_PER_MM;
  const { rect, fitted } = initialRect(pageW, pageH, 'A5', 10.5);
  assert.equal(fitted, false);
  close(rect.w * MM_PER_PT, 306.5);
  close(rect.h * MM_PER_PT, 210);
  close(rect.x + rect.w / 2, pageW / 2);
  const small = initialRect(200 * PT_PER_MM, 150 * PT_PER_MM, 'B5', 16);
  assert.equal(small.fitted, true);
  assert.ok(small.rect.w <= 200 * PT_PER_MM && small.rect.h <= 150 * PT_PER_MM);
  close(small.rect.h / small.rect.w, rectAspect('B5', 16));
});

test('枠はページ内に収まる（移動・拡大・縮小）', () => {
  const pageW = 800, pageH = 500;
  const aspect = rectAspect('A5', 16);
  let r = { x: 100, y: 100, w: 400, h: 400 * aspect };
  r = moveRect(r, 10000, 10000, pageW, pageH);
  assert.ok(r.x + r.w <= pageW + 1e-9 && r.y + r.h <= pageH + 1e-9);
  r = moveRect(r, -10000, -10000, pageW, pageH);
  assert.deepEqual([r.x, r.y], [0, 0]);
  const big = scaleRectAroundCenter({ x: 200, y: 100, w: 400, h: 400 * aspect }, 10, aspect, pageW, pageH);
  assert.ok(big.x >= -1e-9 && big.y >= -1e-9 && big.x + big.w <= pageW + 1e-9 && big.y + big.h <= pageH + 1e-9);
  close(big.h / big.w, aspect);
  const tiny = scaleRectAroundCenter({ x: 200, y: 100, w: 400, h: 400 * aspect }, 0.0001, aspect, pageW, pageH);
  assert.ok(tiny.w >= 10);
  const c = clampRect({ x: -50, y: -50, w: 2000, h: 2000 * aspect }, pageW, pageH);
  assert.ok(c.w <= pageW + 1e-9 && c.h <= pageH + 1e-9);
});

test('四隅の拡縮は反対側の隅を固定し比率を保つ', () => {
  const aspect = rectAspect('shiroku', 5);
  const r = { x: 100, y: 100, w: 300, h: 300 * aspect };
  const anchor = { x: r.x, y: r.y, fx: 0, fy: 0 }; // 左上固定
  const out = resizeRect(r, 350, aspect, anchor, 2000, 2000);
  close(out.x, 100);
  close(out.y, 100);
  close(out.w, 350);
  close(out.h, 350 * aspect);
});

test('寸法差: 四六の実例（表1幅128mm）でも枠を合わせると1%未満', () => {
  const rect = { x: 0, y: 0, w: 272 * PT_PER_MM, h: 188 * PT_PER_MM };
  const dev = sizeDeviation(rect, 'shiroku', 16);
  assert.ok(dev > 0 && dev < 0.01);
});

test('背幅変更では中心と高さを保って比率だけ合わせる', () => {
  const r = { x: 100, y: 50, w: 312 * PT_PER_MM, h: 210 * PT_PER_MM };
  const out = refitRect(r, 'A5', 20, 5000, 5000);
  close(out.h, r.h);
  close(out.x + out.w / 2, r.x + r.w / 2);
  close(out.w * MM_PER_PT, 316);
});

test('座標の往復: 正規化・表示座標（倍率・パン・DPR非依存）', () => {
  const pageW = 1417.3, pageH = 850.4;
  const r = { x: 123.4, y: 56.7, w: 800.1, h: 539.2 };
  const back = fromNormalized(toNormalized(r, pageW, pageH), pageW, pageH);
  for (const k of ['x', 'y', 'w', 'h']) close(back[k], r[k], 1e-9);
  let view = fitView(pageW, pageH, 375, 500);
  for (const factor of [1, 2.5, 0.3, 17]) {
    view = zoomViewAt(view, factor, 120, 80);
    const v = pageToView(view, r.x, r.y);
    const p = viewToPage(view, v.x, v.y);
    close(p.x, r.x, 1e-6);
    close(p.y, r.y, 1e-6);
  }
  // 拡大の中心にある点は動かない
  const before = viewToPage(view, 50, 60);
  const after = viewToPage(zoomViewAt(view, 3, 50, 60), 50, 60);
  close(before.x, after.x, 1e-6);
  close(before.y, after.y, 1e-6);
});

test('未対応の判型・綴じは例外', () => {
  assert.throws(() => spreadSizeMm('A4', 10));
  assert.throws(() => faceRects({ x: 0, y: 0, w: 1, h: 1 }, 'A5', 10, 'up'));
});

test('Shift移動: 移動量の大きい軸だけに固定する', () => {
  assert.deepEqual(lockAxis(10, 3), { dx: 10, dy: 0, axis: 'x' });
  assert.deepEqual(lockAxis(-2, -9), { dx: 0, dy: -9, axis: 'y' });
  assert.deepEqual(lockAxis(5, -5), { dx: 5, dy: 0, axis: 'x' });
  const r = moveRect({ x: 100, y: 100, w: 200, h: 100 }, ...Object.values(lockAxis(40, 12)).slice(0, 2), 1000, 1000);
  assert.deepEqual([r.x, r.y], [140, 100]);
});
