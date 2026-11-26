// 合成PDFの構造とリポジトリの公開方針の検査
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURES, buildPdf, coverLayout } from '../scripts/make-test-pdf.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('合成PDFは生成スクリプトの出力と一致する（手で差し替えられていない）', () => {
  for (const [name, pages] of Object.entries(FIXTURES)) {
    const onDisk = readFileSync(join(ROOT, 'tests', 'fixtures', name));
    assert.ok(onDisk.equals(buildPdf(pages)), `${name} を node scripts/make-test-pdf.mjs で作り直してください`);
  }
});

test('合成PDFのxrefオフセットが正しい', () => {
  const buf = buildPdf(FIXTURES['synthetic-shiroku-s5-right-2pages.pdf']);
  const text = buf.toString('latin1');
  const xref = Number(text.match(/startxref\n(\d+)/)[1]);
  assert.equal(text.slice(xref, xref + 4), 'xref');
  const entries = [...text.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  entries.forEach((off, i) => assert.equal(text.slice(off, off + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`));
  assert.match(text, /\/Rotate 90/);
  assert.match(text, /\/Count 2/);
});

test('CropBox・非ゼロ原点の合成PDF', () => {
  const text = readFileSync(join(ROOT, 'tests', 'fixtures', 'synthetic-b5-s10-left-cropbox-origin.pdf'), 'latin1');
  assert.match(text, /\/MediaBox \[-200 120 /);
  assert.match(text, /\/CropBox \[/);
});

test('レイアウト: 袖・塗り足し・面の幅', () => {
  const L = coverLayout({ trim: 'A5', spine: 10.5, binding: 'left', flap: 90 });
  assert.equal(L.trimW, 90 + 148 + 10.5 + 148 + 90);
  assert.equal(L.faces.back.x < L.faces.front.x, true);
  const R = coverLayout({ trim: 'A5', spine: 10.5, binding: 'right', flap: 90 });
  assert.equal(R.faces.front.x < R.faces.back.x, true);
});

test('公開リポジトリに合成以外のPDF・画像を置かない', () => {
  const allowed = new Set(Object.keys(FIXTURES).map((n) => `tests/fixtures/${n}`));
  // コミット済み＋コミットされうるファイル（.gitignore で除外したローカル検証用ファイルは対象外）
  const git = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(git.status, 0, git.stderr);
  const files = git.stdout.split('\n').filter(Boolean).filter((f) => !f.startsWith('lib/'));
  const pdfs = files.filter((f) => /\.pdf$/i.test(f));
  assert.deepEqual(pdfs.filter((f) => !allowed.has(f)), []);
  const images = files.filter((f) => /\.(png|jpe?g|psd|tiff?|ai)$/i.test(f));
  assert.deepEqual(images, [], '画像は置かない（生成書影の混入防止）');
});

test('外部通信しない: JSに外部URLへのfetch/XHR/解析タグがない', () => {
  const sources = ['js/app.js', 'js/pdf-adapter.js', 'js/book-renderer.js', 'js/crop-editor.js', 'js/compose.js', 'index.html'];
  for (const f of sources) {
    const s = readFileSync(join(ROOT, f), 'utf8');
    assert.doesNotMatch(s, /\bfetch\(|XMLHttpRequest|sendBeacon|googletagmanager|gtag\(|localStorage|sessionStorage|indexedDB/, f);
    assert.doesNotMatch(s, /<script[^>]+src=["']https?:/i, f);
  }
});
