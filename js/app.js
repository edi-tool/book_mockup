/*
SPDX-License-Identifier: Apache-2.0
Copyright 2026 ISHIKAWA, Natsuki
Project: edi-tool
Source: https://github.com/edi-tool
Applies to original code; third-party materials and separately licensed content retain their terms.
*/
// 画面の配線。状態はメモリ上だけに持ち、PDFや設定を保存・送信しない。
import { openPdf, PdfError } from './pdf-adapter.js';
import {
  TRIM_SIZES, FACE_LABELS, MM_PER_PT, parseSpineMm, spreadSizeMm, faceRects, faceOrder, initialRect,
  refitRect, rectSizeMm, sizeDeviation, pixelEdges, faceFractions,
} from './crop-geometry.js';
import { CropEditor } from './crop-editor.js';
import {
  PRESETS, DEFAULT_PRESET, presetView, customView, orbit, nudge, mirrorAngle, orthoPxPerMm, bookRadius,
} from './views.js';
import { neededPxPerMm, planFaceTexture, buildFileName, analyzePixels, validateRender } from './output.js';
import { composeMockup, canvasToBlob, createCanvas, releaseCanvas } from './compose.js';

const $ = (id) => document.getElementById(id);
// プレビューは軽く（影なし・低解像度）。保存時だけPDFから高解像度で描き直して影を付ける
const PREVIEW_MAX = 900;
// 全体プレビューは軽い版を先に出し、裏で高解像度版に差し替える（透明効果の多いPDFは描画が重い）
const BASE_QUICK_SIDE = 1000;
const BASE_FULL_SIDE = 2400;
const BASE_FULL_PIXELS = 4_000_000;
const SINGLE_RENDER_MAX_PIXELS = 16_000_000; // 枠全体を1回で描いて切り分ける上限（iOS Safari の canvas 上限内）
const SINGLE_RENDER_MAX_SIDE = 8192;
const DEVIATION_WARN = 0.015;

const state = {
  doc: null,
  fileName: '',
  pageNumber: 1,
  extraRotation: 0,
  page: null, // { width, height, rotation }
  trimKey: 'A5',
  spineMm: null,
  binding: 'left',
  rect: null,
  presetId: DEFAULT_PRESET, // 自由角度のときは null
  lastPresetId: DEFAULT_PRESET,
  angle: { yaw: 0, pitch: 0 }, // 自由角度
  background: 'transparent',
  sizePx: 2000,
  shadow: true,
  faces: null, // 現在のプレビュー用テクスチャ { front, spine, back }（canvas）
  facesKey: '',
  textureInfo: null,
  exporting: null, // AbortController
};

let loadToken = 0;
let basePageToken = 0;
let facesToken = 0;
let facesAbort = null;
let facesTimer = 0;
let previewRaf = 0;
let renderer = null;
let webglOk = false;
let rendererModule = null;

const editor = new CropEditor($('cropCanvas'), {
  requestDetail: (region, w, h) => {
    if (!state.doc || !state.page) return null;
    return state.doc.renderRegion(state.pageNumber, state.page.rotation, region, w, h);
  },
});

// ---------- 初期化 ----------
async function init() {
  buildPresetChips();
  bindInputs();
  updateSpreadInfo();
  try {
    rendererModule = await import('./book-renderer.js');
    webglOk = rendererModule.webgl2Available();
    if (webglOk) {
      renderer = new rendererModule.BookRenderer({
        onContextLost: () => showNotice('3D描画が一時的に止まりました（WebGLのコンテキスト消失）。復帰を待っています。', 'warn'),
        onContextRestored: () => {
          hideNotice();
          if (state.faces) applyBook(state.faces);
          schedulePreview();
        },
      });
    }
  } catch (err) {
    console.error(err);
    webglOk = false;
  }
  if (!webglOk) {
    showNotice('この環境ではWebGL2が使えないため、立体表示ができません。表1の平面画像（影つき）のみ保存できます。Chrome・Edge・Safariの最新版をお試しください。', 'warn');
    document.querySelectorAll('#presetChips input').forEach((input) => {
      input.disabled = input.value !== 'front';
    });
    state.presetId = 'front';
    document.querySelector('#presetChips input[value="front"]').checked = true;
    $('previewCanvas').removeAttribute('tabindex');
  }
  updateAngleInfo();
  window.addEventListener('unhandledrejection', (e) => {
    console.error(e.reason);
    showNotice(`予期しないエラーが発生しました: ${e.reason?.message || e.reason}`, 'error');
  });
}

function buildPresetChips() {
  const box = $('presetChips');
  for (const p of PRESETS) {
    const label = document.createElement('label');
    label.className = 'chip';
    label.innerHTML = `<input type="radio" name="preset" value="${p.id}"><span></span>`;
    label.querySelector('span').textContent = p.label;
    if (p.id === state.presetId) label.querySelector('input').checked = true;
    box.appendChild(label);
  }
}

function bindInputs() {
  const fileInput = $('fileInput');
  fileInput.addEventListener('change', () => {
    if (fileInput.files?.[0]) handleFile(fileInput.files[0]);
    fileInput.value = '';
  });
  const drop = $('dropZone');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('is-over');
    const file = e.dataTransfer?.files?.[0];
    if (file) handleFile(file);
  });
  // ページ外へのドロップでPDFが開かれて画面が失われないようにする
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  $('pageSelect').addEventListener('change', (e) => {
    state.pageNumber = Number(e.target.value);
    state.extraRotation = 0;
    loadPage({ resetRect: true });
  });
  $('rotateBtn').addEventListener('click', () => {
    state.extraRotation = (state.extraRotation + 90) % 360;
    loadPage({ resetRect: true });
  });

  document.querySelectorAll('input[name="trim"]').forEach((el) => el.addEventListener('change', () => {
    state.trimKey = el.value;
    updateSpreadInfo();
    resetRect();
  }));
  document.querySelectorAll('input[name="binding"]').forEach((el) => el.addEventListener('change', () => {
    state.binding = el.value;
    if (!state.presetId) state.angle = mirrorAngle(state.angle);
    updateAngleInfo();
    updateSpreadInfo();
    syncEditor();
    scheduleFaces(0);
  }));
  const spineInput = $('spineInput');
  const onSpine = (commit) => {
    const raw = spineInput.value;
    const res = parseSpineMm(raw);
    const err = $('spineError');
    if (!res.ok) {
      if (commit || raw.trim() !== '') {
        spineInput.setAttribute('aria-invalid', 'true');
        err.textContent = res.error;
        err.hidden = false;
      }
      return;
    }
    spineInput.removeAttribute('aria-invalid');
    err.hidden = true;
    if (res.value === state.spineMm) return;
    const hadSpine = state.spineMm !== null;
    state.spineMm = res.value;
    updateSpreadInfo();
    if (!state.page) return;
    if (!hadSpine || !state.rect) resetRect();
    else {
      state.rect = refitRect(state.rect, state.trimKey, state.spineMm, state.page.width, state.page.height);
      syncEditor();
      scheduleFaces();
    }
  };
  spineInput.addEventListener('input', () => onSpine(false));
  spineInput.addEventListener('change', () => onSpine(true));
  spineInput.addEventListener('blur', () => onSpine(true));

  editor.addEventListener('change', (e) => {
    state.rect = e.detail.rect;
    updateCropInfo();
    if (e.detail.commit) scheduleFaces();
  });
  $('zoomInBtn').addEventListener('click', () => editor.zoomBy(1.25));
  $('zoomOutBtn').addEventListener('click', () => editor.zoomBy(0.8));
  $('fitPageBtn').addEventListener('click', () => editor.fitToPage());
  $('fitRectBtn').addEventListener('click', () => editor.fitToRect());
  $('resetRectBtn').addEventListener('click', () => resetRect());

  $('presetChips').addEventListener('change', (e) => {
    if (e.target.name !== 'preset') return;
    selectPreset(e.target.value);
  });
  bindOrbit($('previewCanvas'));
  document.querySelectorAll('input[name="bg"]').forEach((el) => el.addEventListener('change', () => {
    state.background = el.value;
    $('previewWrap').classList.toggle('is-white', state.background === 'white');
    $('previewWrap').classList.toggle('checker', state.background !== 'white');
    schedulePreview();
  }));
  document.querySelectorAll('input[name="size"]').forEach((el) => el.addEventListener('change', () => {
    state.sizePx = Number(el.value);
  }));
  $('shadowToggle').addEventListener('change', (e) => {
    state.shadow = e.target.checked;
  });
  $('saveBtn').addEventListener('click', () => exportPng());
  $('cancelBtn').addEventListener('click', () => state.exporting?.abort());
  new ResizeObserver(() => schedulePreview()).observe($('previewWrap'));
}

// ---------- PDF ----------
async function handleFile(file) {
  const token = ++loadToken;
  state.exporting?.abort();
  setStatus('fileStatus', '読み込んでいます…');
  hideNotice();
  if (file.type && file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) {
    setStatus('fileStatus', '');
    showNotice('PDFファイルを選んでください。', 'error');
    return;
  }
  try {
    const buf = await file.arrayBuffer();
    if (token !== loadToken) return;
    const doc = await openPdf(buf);
    if (token !== loadToken) {
      doc.destroy();
      return;
    }
    await closeDocument();
    state.doc = doc;
    state.fileName = file.name;
    state.pageNumber = 1;
    state.extraRotation = 0;
    const sel = $('pageSelect');
    sel.innerHTML = '';
    for (let i = 1; i <= doc.numPages; i++) sel.add(new Option(`${i} / ${doc.numPages}`, String(i)));
    $('pageControls').hidden = false;
    await loadPage({ resetRect: true, token });
  } catch (err) {
    if (token !== loadToken) return;
    console.error(err);
    const msg = err instanceof PdfError ? err.message : `PDFを読み込めませんでした（${err?.message || err}）。`;
    setStatus('fileStatus', '');
    showNotice(msg, 'error');
  }
}

async function closeDocument() {
  cancelFaces();
  releaseFaces();
  renderer?.clearBook();
  editor.clear();
  state.rect = null;
  state.page = null;
  const old = state.doc;
  state.doc = null;
  if (old) await old.destroy();
  $('editorEmpty').hidden = false;
  $('previewEmpty').hidden = false;
  clearPreview();
  $('faces').innerHTML = '';
  updateSaveButton();
}

async function loadPage({ resetRect: reset = false, token = loadToken } = {}) {
  if (!state.doc) return;
  cancelFaces();
  try {
    const pageToken = ++basePageToken;
    const info = await state.doc.pageInfo(state.pageNumber, state.extraRotation);
    if (token !== loadToken || pageToken !== basePageToken) return;
    const whole = { x: 0, y: 0, w: info.width, h: info.height };
    const sizeFor = (side, pixels = Infinity) => {
      const s = Math.min(side / Math.max(info.width, info.height), Math.sqrt(pixels / (info.width * info.height)));
      return [Math.max(1, Math.round(info.width * s)), Math.max(1, Math.round(info.height * s))];
    };
    setStatus('fileStatus', 'ページを描画しています…');
    const [qw, qh] = sizeFor(BASE_QUICK_SIDE);
    const quick = await state.doc.renderRegion(state.pageNumber, info.rotation, whole, qw, qh);
    if (token !== loadToken || pageToken !== basePageToken) {
      releaseCanvas(quick);
      return;
    }
    state.page = info;
    editor.setPage(info, { canvas: quick, scale: qw / info.width });
    $('editorEmpty').hidden = true;
    $('rotationTag').textContent = `回転 ${info.rotation}°`;
    const mm = (v) => (v * MM_PER_PT).toFixed(1);
    const summary = `${state.doc.numPages}ページ・このページは ${mm(info.width)}×${mm(info.height)} mm${info.userUnit !== 1 ? `（UserUnit ${info.userUnit}）` : ''}`;
    setStatus('fileStatus', `${summary}（高精細表示を準備中…）`);
    if (reset || !state.rect) resetRect();
    const [fw, fh] = sizeFor(BASE_FULL_SIDE, BASE_FULL_PIXELS);
    if (fw > qw) {
      const full = await state.doc.renderRegion(state.pageNumber, info.rotation, whole, fw, fh);
      if (token !== loadToken || pageToken !== basePageToken) {
        releaseCanvas(full);
        return;
      }
      editor.updateBase({ canvas: full, scale: fw / info.width });
    }
    setStatus('fileStatus', summary);
  } catch (err) {
    if (token !== loadToken) return;
    console.error(err);
    showNotice(err instanceof PdfError ? err.message : 'ページを描画できませんでした。', 'error');
  }
}

// ---------- 判型・枠 ----------
function updateSpreadInfo() {
  const trim = TRIM_SIZES[state.trimKey];
  if (state.spineMm === null) {
    $('spreadInfo').textContent = `${trim.label} ${trim.width}×${trim.height} mm。背幅を入力すると展開寸法を計算します。`;
    return;
  }
  const s = spreadSizeMm(state.trimKey, state.spineMm);
  const order = faceOrder(state.binding).map((f) => FACE_LABELS[f]).join('・');
  $('spreadInfo').textContent = `展開の仕上がり ${fmt(s.width)}×${s.height} mm（左から ${order}）`;
}

function resetRect() {
  if (!state.page || state.spineMm === null) {
    syncEditor();
    updateCropInfo();
    return;
  }
  const { rect, fitted } = initialRect(state.page.width, state.page.height, state.trimKey, state.spineMm);
  state.rect = rect;
  syncEditor();
  updateCropInfo(fitted);
  scheduleFaces(0);
}

function syncEditor() {
  if (state.spineMm === null || !state.rect) {
    editor.setSpec(null, null);
    return;
  }
  editor.setSpec({ trimKey: state.trimKey, spineMm: state.spineMm, binding: state.binding }, state.rect);
}

function updateCropInfo(fitted = false) {
  const warn = $('cropWarn');
  if (!state.rect || state.spineMm === null) {
    setStatus('cropInfo', state.page ? '背幅を入力すると、仕上がり枠が表示されます。' : '');
    warn.hidden = true;
    return;
  }
  const size = rectSizeMm(state.rect);
  const s = spreadSizeMm(state.trimKey, state.spineMm);
  const dev = sizeDeviation(state.rect, state.trimKey, state.spineMm);
  const pos = { x: state.rect.x * MM_PER_PT, y: state.rect.y * MM_PER_PT };
  setStatus('cropInfo', `枠 ${fmt(size.width)}×${fmt(size.height)} mm（指定 ${fmt(s.width)}×${s.height} mm、差 ${(dev * 100).toFixed(1)}%）・位置 左${fmt(pos.x)} 上${fmt(pos.y)} mm`);
  const msgs = [];
  if (fitted) msgs.push('PDFのページが指定の展開寸法より小さいため、枠を縮めて表示しています。判型・背幅とPDFを確認してください。');
  if (Math.abs(dev) > DEVIATION_WARN) msgs.push(`枠の大きさが指定寸法と${(Math.abs(dev) * 100).toFixed(1)}%違います。PDFが縮小・拡大されているか、判型・背幅が違う可能性があります（画像は枠のとおりに切り出します）。`);
  warn.hidden = msgs.length === 0;
  warn.textContent = msgs.join(' ');
  warn.dataset.icon = msgs.length ? 'info' : '';
}

// ---------- 面テクスチャ ----------
function bookDims() {
  const trim = TRIM_SIZES[state.trimKey];
  return { W: trim.width, H: trim.height, S: state.spineMm };
}

function cancelFaces() {
  clearTimeout(facesTimer);
  facesAbort?.abort();
  facesAbort = null;
  facesToken++;
}

function releaseFaces() {
  if (state.faces) Object.values(state.faces).forEach(releaseCanvas);
  state.faces = null;
  state.facesKey = '';
}

function scheduleFaces(delay = 250) {
  clearTimeout(facesTimer);
  if (!state.doc || !state.rect || state.spineMm === null) return;
  facesTimer = setTimeout(() => renderPreviewFaces(), delay);
}

function previewPx() {
  const wrap = $('previewWrap');
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  return Math.max(320, Math.min(PREVIEW_MAX, Math.round(wrap.clientWidth * dpr)));
}

// 枠から3面を作る。原則は枠全体をPDFから1回で描き、累積境界を丸めて切り分ける（隙間・重なりなし）。
// 大きすぎる場合だけ面ごとに描く。PDFの描画は重いことがあるため、回数を減らすのを優先する。
async function renderFaces({ pxPerMm, signal }) {
  const dims = bookDims();
  const maxTex = renderer?.maxTextureSize ?? 4096;
  const spreadW = dims.W * 2 + dims.S;
  let s = pxPerMm;
  let reduced = false;
  for (const wMm of [dims.W, dims.S]) {
    const plan = planFaceTexture(wMm, dims.H, s, maxTex);
    if (plan.reduced) {
      s = plan.pxPerMm;
      reduced = true;
    }
  }
  const totalW = Math.round(spreadW * s);
  const totalH = Math.max(1, Math.round(dims.H * s));
  const order = faceOrder(state.binding);
  const out = {};
  try {
    if (totalW * totalH <= SINGLE_RENDER_MAX_PIXELS && totalW <= SINGLE_RENDER_MAX_SIDE) {
      const whole = await state.doc.renderRegion(state.pageNumber, state.page.rotation, state.rect, totalW, totalH, signal);
      const edges = pixelEdges(0, totalW, faceFractions(state.trimKey, state.spineMm));
      order.forEach((face, i) => {
        const w = Math.max(1, edges[i + 1] - edges[i]);
        const c = createCanvas(w, totalH);
        c.getContext('2d').drawImage(whole, edges[i], 0, w, totalH, 0, 0, w, totalH);
        out[face] = c;
      });
      releaseCanvas(whole);
    } else {
      const rects = faceRects(state.rect, state.trimKey, state.spineMm, state.binding);
      for (const face of order) {
        const wMm = face === 'spine' ? dims.S : dims.W;
        const plan = planFaceTexture(wMm, dims.H, s, maxTex);
        out[face] = await state.doc.renderRegion(state.pageNumber, state.page.rotation, rects[face], plan.width, plan.height, signal);
        if (signal?.aborted) throw new PdfError('cancelled', '処理を中止しました。');
      }
    }
  } catch (err) {
    Object.values(out).forEach(releaseCanvas);
    throw err;
  }
  return { faces: out, reduced, ppi: s * 25.4 };
}

async function renderPreviewFaces() {
  cancelFaces();
  const token = facesToken;
  const abort = new AbortController();
  facesAbort = abort;
  const dims = bookDims();
  const pxPerMm = neededPxPerMm(previewPx(), Math.max(dims.H, dims.W));
  setStatus('facesStatus', '面をPDFから描画しています…');
  try {
    const { faces } = await renderFaces({ pxPerMm, signal: abort.signal });
    if (token !== facesToken) {
      Object.values(faces).forEach(releaseCanvas);
      return;
    }
    releaseFaces();
    state.faces = faces;
    setStatus('facesStatus', '');
    showFaceThumbs();
    applyBook(faces);
    $('previewEmpty').hidden = true;
    schedulePreview();
    updateSaveButton();
  } catch (err) {
    if (err?.code === 'cancelled' || token !== facesToken) return;
    setStatus('facesStatus', '');
    console.error(err);
    showNotice(err instanceof PdfError ? err.message : '面の切り出しに失敗しました。', 'error');
  }
}

function showFaceThumbs() {
  const box = $('faces');
  box.innerHTML = '';
  const dims = bookDims();
  for (const face of faceOrder(state.binding)) {
    const src = state.faces[face];
    const fig = document.createElement('figure');
    fig.className = 'face';
    const c = document.createElement('canvas');
    const h = Math.min(src.height, 520);
    c.height = h;
    c.width = Math.max(1, Math.round((src.width * h) / src.height));
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    const w = face === 'spine' ? dims.S : dims.W;
    c.setAttribute('role', 'img');
    c.setAttribute('aria-label', `${FACE_LABELS[face]}（${fmt(w)}×${dims.H} mm）`);
    const cap = document.createElement('figcaption');
    cap.textContent = `${FACE_LABELS[face]} ${fmt(w)}mm`;
    fig.append(c, cap);
    box.append(fig);
  }
}

function applyBook(faces) {
  if (!renderer) return;
  renderer.setBook(bookDims(), state.binding, faces);
}

// ---------- プレビュー ----------
function schedulePreview() {
  cancelAnimationFrame(previewRaf);
  previewRaf = requestAnimationFrame(() => drawPreview());
}

function clearPreview() {
  const c = $('previewCanvas');
  c.getContext('2d').clearRect(0, 0, c.width, c.height);
}

function currentView() {
  return state.presetId ? presetView(state.presetId, state.binding) : customView(state.angle);
}

// ---------- 角度 ----------
function selectPreset(id) {
  state.presetId = id;
  state.lastPresetId = id;
  const input = document.querySelector(`#presetChips input[value="${id}"]`);
  if (input) input.checked = true;
  updateAngleInfo();
  schedulePreview();
}

// 自由角度へ移る。プリセットの選択表示は外す
function setCustomAngle(angle) {
  state.angle = angle;
  if (state.presetId) {
    state.presetId = null;
    const checked = document.querySelector('#presetChips input:checked');
    if (checked) checked.checked = false;
  }
  updateAngleInfo();
  schedulePreview();
}

function updateAngleInfo() {
  const v = currentView();
  const label = state.presetId ? PRESETS.find((p) => p.id === state.presetId).label : '自由角度';
  $('angleInfo').textContent = `${label}・水平 ${Math.round(v.yaw)}°・仰角 ${Math.round(v.pitch)}°${v.projection === 'ortho' ? '（正投影）' : ''}`;
}

// プレビューの左ドラッグで回転、ダブルクリックで直前のプリセット、矢印キーで1°（Shiftで5°）
function bindOrbit(canvas) {
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !webglOk || !state.faces || state.exporting) return;
    canvas.setPointerCapture(e.pointerId);
    const v = currentView();
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, angle: { yaw: v.yaw, pitch: v.pitch }, moved: false };
    canvas.classList.add('is-dragging');
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 3) return;
    drag.moved = true;
    setCustomAngle(orbit(drag.angle, dx, dy));
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    canvas.classList.remove('is-dragging');
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('dblclick', () => {
    if (webglOk && state.faces) selectPreset(state.lastPresetId);
  });
  canvas.addEventListener('keydown', (e) => {
    if (!webglOk || !state.faces || state.exporting) return;
    const step = e.shiftKey ? 5 : 1;
    const v = currentView();
    const delta = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (delta) {
      e.preventDefault();
      setCustomAngle(nudge({ yaw: v.yaw, pitch: v.pitch }, delta[0], delta[1]));
    } else if (e.key === 'Home') {
      e.preventDefault();
      selectPreset(state.lastPresetId);
    }
  });
}

// 透明背景の本の画像を作る（WebGL2が無い場合は表1の平面）
function renderBook(size) {
  if (webglOk && renderer) return renderer.render(currentView(), size);
  return renderFlatFront(state.faces.front, size);
}

// 3Dの正面（正投影）と同じ縮尺で表1を平面に置く
function renderFlatFront(front, size) {
  const c = createCanvas(size, size);
  const { W, H, S } = bookDims();
  const k = orthoPxPerMm(size, bookRadius(W, H, S));
  const w = W * k;
  const h = H * k;
  c.getContext('2d').drawImage(front, (size - w) / 2, (size - h) / 2, w, h);
  return c;
}

function drawPreview() {
  if (!state.faces || state.exporting) return;
  const size = previewPx();
  const canvas = $('previewCanvas');
  try {
    const book = renderBook(size);
    const composed = composeMockup(book, size, { background: state.background, shadow: false });
    canvas.width = size;
    canvas.height = size;
    canvas.getContext('2d').drawImage(composed, 0, 0);
    releaseCanvas(book);
    releaseCanvas(composed);
    canvas.setAttribute('aria-label', `立体書影のプレビュー（${$('angleInfo').textContent}）`);
  } catch (err) {
    console.error(err);
    showNotice(`プレビューを描画できませんでした: ${err.message}`, 'error');
  }
}

// ---------- 保存 ----------
function updateSaveButton() {
  $('saveBtn').disabled = !state.faces || Boolean(state.exporting);
}

async function exportPng() {
  if (!state.faces || state.exporting) return;
  const abort = new AbortController();
  state.exporting = abort;
  const size = state.sizePx;
  const token = loadToken;
  setBusy(true);
  setStatus('saveStatus', `${size}px で書き出しています（PDFから再描画中）…`);
  let exportFaces = null;
  try {
    if (renderer && size > renderer.maxRenderSize) {
      throw new Error(`この端末では一辺${renderer.maxRenderSize}pxまでしか書き出せません。小さいサイズを選んでください。`);
    }
    const dims = bookDims();
    const pxPerMm = neededPxPerMm(size, Math.max(dims.H, dims.W));
    const result = await renderFaces({ pxPerMm, signal: abort.signal });
    exportFaces = result.faces;
    if (abort.signal.aborted || token !== loadToken) throw new PdfError('cancelled', '中止しました。');
    applyBook(exportFaces);
    const book = webglOk && renderer ? renderer.render(currentView(), size) : renderFlatFront(exportFaces.front, size);
    const composed = composeMockup(book, size, { background: state.background, shadow: state.shadow });
    releaseCanvas(book);
    const stats = analyzePixels(composed.getContext('2d').getImageData(0, 0, size, size).data, size, size, 6);
    const check = validateRender(stats);
    if (!check.ok) {
      releaseCanvas(composed);
      throw new Error(check.error);
    }
    const blob = await canvasToBlob(composed);
    releaseCanvas(composed);
    if (abort.signal.aborted) throw new PdfError('cancelled', '中止しました。');
    const name = buildFileName({
      sourceName: state.fileName,
      presetId: currentView().id,
      trimLabel: TRIM_SIZES[state.trimKey].label,
      spineMm: state.spineMm,
      sizePx: size,
    });
    downloadBlob(blob, name);
    const note = `テクスチャ約${Math.round(result.ppi)}ppi相当${result.reduced ? '（端末の上限により縮小）' : ''}`;
    setStatus('saveStatus', `保存しました: ${name}（${size}×${size}px、${state.background === 'white' ? '白背景' : '透過'}）`);
    $('textureNote').textContent = note;
    announce('PNGを保存しました');
  } catch (err) {
    if (err?.code === 'cancelled') setStatus('saveStatus', '書き出しを中止しました。');
    else {
      console.error(err);
      setStatus('saveStatus', '');
      showNotice(`保存できませんでした: ${err.message}`, 'error');
    }
  } finally {
    if (exportFaces) Object.values(exportFaces).forEach(releaseCanvas);
    state.exporting = null;
    setBusy(false);
    if (state.faces) applyBook(state.faces);
    schedulePreview();
  }
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function setBusy(busy) {
  $('cancelBtn').hidden = !busy;
  updateSaveButton();
  for (const el of document.querySelectorAll('#stepFile input, #stepFile select, #stepFile button, #stepSpec input, #stepCrop button, #stepMockup input')) {
    if (busy) {
      el.dataset.wasDisabled = el.disabled ? '1' : '';
      el.disabled = true;
    } else {
      el.disabled = el.dataset.wasDisabled === '1';
      delete el.dataset.wasDisabled;
    }
  }
}

// ---------- 表示補助 ----------
function setStatus(id, text) {
  $(id).textContent = text;
}

function showNotice(text, kind = 'warn') {
  const el = $('globalNotice');
  el.textContent = text;
  el.className = kind === 'error' ? 'notice notice-error' : 'notice';
  el.dataset.icon = kind === 'error' ? 'warn' : 'info';
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.hidden = false;
}

function hideNotice() {
  $('globalNotice').hidden = true;
}

function announce(text) {
  const live = $('et-live');
  live.textContent = '';
  setTimeout(() => { live.textContent = text; }, 50);
}

function fmt(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

init();
