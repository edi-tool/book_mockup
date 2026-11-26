#!/usr/bin/env node
// 公開テスト用の合成カバーPDFを作る（依存ゼロ）。実際の書籍データは使わない。
// 表1/背/表4/袖を別色で塗り、塗り足し3mm・トンボ・折りトンボ・天地左右の文字を入れる。
// 使い方: node scripts/make-test-pdf.mjs  → tests/fixtures/*.pdf
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PT = 72 / 25.4;
const TRIMS = { B5: [182, 257], A5: [148, 210], shiroku: [127, 188] };
const COLORS = { flap: [0.82, 0.82, 0.84], back: [0.16, 0.42, 0.75], spine: [0.95, 0.45, 0.1], front: [0.15, 0.6, 0.35] };

// 版面のレイアウト（mm、左下原点のPDF座標ではなく「左上原点」の値も返す）
export function coverLayout({ trim, spine, binding = 'left', flap = 80, bleed = 3, margin = 15 }) {
  const [W, H] = TRIMS[trim];
  const order = binding === 'left' ? ['back', 'spine', 'front'] : ['front', 'spine', 'back'];
  const panels = [{ face: 'flapL', w: flap }, ...order.map((face) => ({ face, w: face === 'spine' ? spine : W })), { face: 'flapR', w: flap }];
  const trimW = panels.reduce((s, p) => s + p.w, 0);
  const pageW = trimW + (bleed + margin) * 2;
  const pageH = H + (bleed + margin) * 2;
  let x = bleed + margin;
  const placed = panels.map((p) => {
    const r = { ...p, x, y: bleed + margin, h: H };
    x += p.w;
    return r;
  });
  const faces = Object.fromEntries(placed.filter((p) => !p.face.startsWith('flap')).map((p) => [p.face, p]));
  const spread = { x: faces[order[0]].x, y: bleed + margin, w: W * 2 + spine, h: H };
  return { pageW, pageH, trimX: bleed + margin, trimY: bleed + margin, trimW, H, W, bleed, margin, panels: placed, faces, spread };
}

function n(v) {
  return Number(v.toFixed(3)).toString();
}

// 1ページ分の内容ストリーム。ox, oy: MediaBox の原点（非ゼロ原点の検証用）
function pageContent(L, ox = 0, oy = 0) {
  const ops = [];
  const X = (mm) => ox + mm * PT;
  const Y = (mmTop) => oy + (L.pageH - mmTop) * PT; // 上端からの距離 → PDF座標
  const rect = (x, yTop, w, h) => `${n(X(x))} ${n(Y(yTop + h))} ${n(w * PT)} ${n(h * PT)} re`;
  const fill = (c) => `${c.map(n).join(' ')} rg`;
  // 塗り（左右端と天地は塗り足し分まで伸ばす）
  L.panels.forEach((p, i) => {
    const color = p.face.startsWith('flap') ? COLORS.flap : COLORS[p.face];
    const x0 = i === 0 ? p.x - L.bleed : p.x;
    const x1 = i === L.panels.length - 1 ? p.x + p.w + L.bleed : p.x + p.w;
    ops.push(fill(color), `${rect(x0, p.y - L.bleed, x1 - x0, p.h + L.bleed * 2)} f`);
  });
  // 面の文字と向きの印（天に三角）
  const text = (s, xmm, ytop, size, color = [1, 1, 1]) =>
    ops.push(`BT /F1 ${n(size)} Tf ${fill(color)} ${n(X(xmm))} ${n(Y(ytop))} Td (${s}) Tj ET`);
  for (const p of L.panels) {
    const name = { flapL: 'FLAP', flapR: 'FLAP', back: 'BACK', spine: 'S', front: 'FRONT' }[p.face];
    const size = Math.min(28, p.w * 0.5) ;
    text(name, p.x + 2, p.y + p.h / 2, size);
    text('TOP', p.x + 2, p.y + 8, Math.min(10, p.w * 0.6));
    text('BTM', p.x + 2, p.y + p.h - 3, Math.min(10, p.w * 0.6));
    if (p.w > 20) {
      text('L', p.x + 2, p.y + p.h * 0.75, 12);
      text('R', p.x + p.w - 7, p.y + p.h * 0.75, 12);
      const cx = p.x + p.w / 2;
      ops.push('1 1 1 rg', `${n(X(cx))} ${n(Y(p.y + 12))} m ${n(X(cx - 5))} ${n(Y(p.y + 22))} l ${n(X(cx + 5))} ${n(Y(p.y + 22))} l f`);
    }
  }
  // トンボ（0.1mm線、黒）
  ops.push('0 0 0 RG', `${n(0.1 * PT)} w`);
  const line = (x1, y1, x2, y2) => ops.push(`${n(X(x1))} ${n(Y(y1))} m ${n(X(x2))} ${n(Y(y2))} l S`);
  const top = L.trimY;
  const bottom = L.trimY + L.H;
  const len = L.margin - 2;
  const xs = [L.trimX, ...L.panels.map((p) => p.x + p.w)];
  // 四隅は仕上がり線と塗り足し線の二重
  for (const [x, dir] of [[L.trimX, -1], [L.trimX + L.trimW, 1]]) {
    for (const off of [0, L.bleed]) {
      line(x + dir * off, top - L.bleed - len, x + dir * off, top - L.bleed);
      line(x + dir * off, bottom + L.bleed, x + dir * off, bottom + L.bleed + len);
    }
    for (const off of [0, L.bleed]) {
      const xa = dir < 0 ? x - L.bleed - len : x + L.bleed;
      line(xa, top - off, xa + len, top - off);
      line(xa, bottom + off, xa + len, bottom + off);
    }
  }
  // 折りトンボ（面の境界）
  for (const x of xs.slice(1, -1)) {
    line(x, top - L.bleed - len, x, top - L.bleed - 2);
    line(x, bottom + L.bleed + 2, x, bottom + L.bleed + len);
  }
  return ops.join('\n');
}

// ページの配列 { layout, rotate, mediaOrigin:[ox,oy], cropInset(mm) } からPDFを作る
export function buildPdf(pages) {
  const objects = [];
  const add = (body) => {
    objects.push(body);
    return objects.length;
  };
  const catalog = add(null);
  const pagesObj = add(null);
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids = [];
  for (const pg of pages) {
    const L = pg.layout;
    const [ox, oy] = pg.mediaOrigin ?? [0, 0];
    const content = pageContent(L, ox, oy);
    const stream = add(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
    const w = L.pageW * PT;
    const h = L.pageH * PT;
    const media = [ox, oy, ox + w, oy + h];
    const inset = (pg.cropInset ?? 0) * PT;
    const crop = [ox + inset, oy + inset, ox + w - inset, oy + h - inset];
    const entries = [
      '/Type /Page', `/Parent ${pagesObj} 0 R`, `/MediaBox [${media.map(n).join(' ')}]`,
      inset ? `/CropBox [${crop.map(n).join(' ')}]` : '',
      pg.rotate ? `/Rotate ${pg.rotate}` : '',
      `/Resources << /Font << /F1 ${font} 0 R >> >>`, `/Contents ${stream} 0 R`,
    ].filter(Boolean);
    kids.push(add(`<< ${entries.join(' ')} >>`));
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

export const FIXTURES = {
  'synthetic-a5-s16-left.pdf': [{ layout: coverLayout({ trim: 'A5', spine: 16, binding: 'left', flap: 90 }) }],
  'synthetic-shiroku-s5-right-2pages.pdf': [
    { layout: coverLayout({ trim: 'shiroku', spine: 5, binding: 'right', flap: 80 }) },
    { layout: coverLayout({ trim: 'shiroku', spine: 5, binding: 'right', flap: 0 }), rotate: 90 },
  ],
  'synthetic-b5-s10-left-cropbox-origin.pdf': [
    { layout: coverLayout({ trim: 'B5', spine: 10, binding: 'left', flap: 60, margin: 25 }), mediaOrigin: [-200, 120], cropInset: 8 },
  ],
};

function main() {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures');
  mkdirSync(dir, { recursive: true });
  for (const [name, pages] of Object.entries(FIXTURES)) {
    writeFileSync(join(dir, name), buildPdf(pages));
    console.log(`作成: tests/fixtures/${name}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
