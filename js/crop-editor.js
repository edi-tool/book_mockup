/*
SPDX-License-Identifier: Apache-2.0
Copyright 2026 ISHIKAWA, Natsuki
Project: edi-tool
Source: https://github.com/edi-tool
Applies to original code; third-party materials and separately licensed content retain their terms.
*/
// 仕上がり範囲エディタ。ページ全体のプレビューに枠・面境界・枠外マスクを重ね、
// ドラッグ（移動）、四隅（均等拡縮）、ホイール/ピンチ（表示拡大）、キーボード微調整を扱う。
// 座標の考え方は edi-tool/kokuban-adjust（MIT）の「表示座標と原寸の分離」を参考にした。
import {
  PT_PER_MM, FACE_LABELS, faceRects, clampRect, moveRect, lockAxis, resizeRect, scaleRectAroundCenter,
  rectAspect, fitView, zoomViewAt, pageToView, viewToPage,
} from './crop-geometry.js';

const HANDLE = 22; // 四隅のつまみの当たり判定（CSS px）

export class CropEditor extends EventTarget {
  constructor(canvas, { requestDetail } = {}) {
    super();
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.requestDetail = requestDetail;
    this.page = null; // { width, height }
    this.base = null; // { canvas, scale } ページ全体のプレビュー（scale = px/pt）
    this.detail = null; // { canvas, region } 拡大時の高精細
    this.rect = null;
    this.spec = null; // { trimKey, spineMm, binding }
    this.view = { scale: 1, originX: 0, originY: 0 };
    this.pointers = new Map();
    this.drag = null;
    this.detailTimer = 0;
    this.detailToken = 0;

    canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    canvas.addEventListener('pointerup', (e) => this.onPointerUp(e));
    canvas.addEventListener('pointercancel', (e) => this.onPointerUp(e));
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    canvas.addEventListener('keydown', (e) => this.onKey(e));
    // ドラッグ中に Shift を押す・離すと、マウスを動かさなくても軸固定を切り替える
    this.onShift = (e) => {
      if (e.key === 'Shift' && this.drag?.mode === 'move') this.applyMove(e.type === 'keydown');
    };
    window.addEventListener('keydown', this.onShift);
    window.addEventListener('keyup', this.onShift);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement);
  }

  setPage(page, base) {
    this.page = page;
    this.releaseDetail();
    if (this.base && this.base.canvas !== base.canvas) {
      this.base.canvas.width = 0;
      this.base.canvas.height = 0;
    }
    this.base = base;
    this.resize(true);
  }

  // 同じページの全体プレビューを高解像度版に差し替える（表示位置は変えない）
  updateBase(base) {
    if (this.base && this.base.canvas !== base.canvas) {
      this.base.canvas.width = 0;
      this.base.canvas.height = 0;
    }
    this.base = base;
    this.draw();
    this.scheduleDetail();
  }

  setSpec(spec, rect) {
    this.spec = spec;
    this.rect = rect;
    this.draw();
  }

  clear() {
    this.page = null;
    if (this.base) {
      this.base.canvas.width = 0;
      this.base.canvas.height = 0;
    }
    this.base = null;
    this.rect = null;
    this.releaseDetail();
    this.draw();
  }

  get aspect() {
    return rectAspect(this.spec.trimKey, this.spec.spineMm);
  }

  // 表示領域の大きさが変わったら、利用者が拡大・移動していなければ全体表示し直し、
  // していれば表示の中心を保つ。
  resize(refit = false) {
    const parent = this.canvas.parentElement;
    const w = Math.max(1, parent.clientWidth);
    const h = Math.max(1, parent.clientHeight);
    const center = this.cssW ? viewToPage(this.view, this.cssW / 2, this.cssH / 2) : null;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.cssW = w;
    this.cssH = h;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.dpr = dpr;
    if (refit || !this.userView || !center) {
      this.fitToPage();
    } else {
      this.view = { scale: this.view.scale, originX: center.x - w / 2 / this.view.scale, originY: center.y - h / 2 / this.view.scale };
      this.afterViewChange();
    }
  }

  fitToPage() {
    this.userView = false;
    if (!this.page) return this.draw();
    this.view = fitView(this.page.width, this.page.height, this.cssW, this.cssH);
    this.afterViewChange();
  }

  fitToRect() {
    if (!this.page || !this.rect) return;
    const r = this.rect;
    this.userView = true;
    const pad = 24;
    const scale = Math.min((this.cssW - pad * 2) / r.w, (this.cssH - pad * 2) / r.h);
    this.view = { scale, originX: r.x + r.w / 2 - this.cssW / 2 / scale, originY: r.y + r.h / 2 - this.cssH / 2 / scale };
    this.afterViewChange();
  }

  zoomBy(factor) {
    this.userView = true;
    this.view = zoomViewAt(this.view, factor, this.cssW / 2, this.cssH / 2);
    this.afterViewChange();
  }

  afterViewChange() {
    this.draw();
    this.scheduleDetail();
  }

  // 表示倍率が全体プレビューの解像度を超えたら、見えている範囲だけ高精細に描き直す。
  scheduleDetail() {
    clearTimeout(this.detailTimer);
    if (!this.page || !this.base || !this.requestDetail) return;
    const needed = this.view.scale * this.dpr;
    if (needed <= this.base.scale * 1.15) {
      this.releaseDetail();
      this.draw();
      return;
    }
    this.detailTimer = setTimeout(async () => {
      const token = ++this.detailToken;
      const tl = viewToPage(this.view, 0, 0);
      const br = viewToPage(this.view, this.cssW, this.cssH);
      const region = {
        x: Math.max(0, tl.x), y: Math.max(0, tl.y),
        w: Math.min(this.page.width, br.x) - Math.max(0, tl.x),
        h: Math.min(this.page.height, br.y) - Math.max(0, tl.y),
      };
      if (region.w <= 0 || region.h <= 0) return;
      const outW = Math.round(region.w * needed);
      const outH = Math.round(region.h * needed);
      try {
        const canvas = await this.requestDetail(region, outW, outH);
        if (!canvas) return;
        if (token !== this.detailToken) {
          canvas.width = 0;
          return;
        }
        this.releaseDetail();
        this.detail = { canvas, region };
        this.draw();
      } catch {
        // 中止・失敗時は全体プレビューのまま
      }
    }, 180);
  }

  releaseDetail() {
    if (this.detail) {
      this.detail.canvas.width = 0;
      this.detail.canvas.height = 0;
    }
    this.detail = null;
  }

  setRect(rect, { commit = true } = {}) {
    this.rect = clampRect(rect, this.page.width, this.page.height);
    this.draw();
    this.dispatchEvent(new CustomEvent('change', { detail: { rect: this.rect, commit } }));
  }

  // ---- 描画 ----
  draw() {
    const { ctx, canvas } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!this.page || !this.base) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const v = this.view;
    const p0 = pageToView(v, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#fff';
    ctx.fillRect(p0.x, p0.y, this.page.width * v.scale, this.page.height * v.scale);
    ctx.drawImage(this.base.canvas, p0.x, p0.y, this.page.width * v.scale, this.page.height * v.scale);
    if (this.detail) {
      const d = this.detail.region;
      const q = pageToView(v, d.x, d.y);
      ctx.drawImage(this.detail.canvas, q.x, q.y, d.w * v.scale, d.h * v.scale);
    }
    if (!this.rect || !this.spec) return;
    const r = this.rect;
    const a = pageToView(v, r.x, r.y);
    const rw = r.w * v.scale;
    const rh = r.h * v.scale;
    // 枠外マスク
    ctx.save();
    ctx.fillStyle = 'rgba(20, 20, 24, 0.55)';
    ctx.beginPath();
    ctx.rect(0, 0, this.cssW, this.cssH);
    ctx.rect(a.x, a.y, rw, rh);
    ctx.fill('evenodd');
    ctx.restore();
    // 面境界とラベル
    const faces = faceRects(r, this.spec.trimKey, this.spec.spineMm, this.spec.binding);
    ctx.save();
    ctx.lineWidth = 1;
    for (const key of ['front', 'spine', 'back']) {
      const f = faces[key];
      const fa = pageToView(v, f.x, f.y);
      if (key === 'spine') {
        ctx.fillStyle = 'rgba(255, 106, 0, 0.10)';
        ctx.fillRect(fa.x, fa.y, f.w * v.scale, rh);
      }
      const label = FACE_LABELS[key];
      ctx.font = '600 13px system-ui, sans-serif';
      const tw = ctx.measureText(label).width;
      const cx = fa.x + (f.w * v.scale) / 2;
      const ly = Math.max(a.y + 6, 6);
      ctx.fillStyle = 'rgba(10,10,10,0.78)';
      roundRect(ctx, cx - tw / 2 - 7, ly, tw + 14, 22, 11);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, cx, ly + 11);
    }
    const xs = [faces.spine.x, faces.spine.x + faces.spine.w];
    for (const x of xs) {
      const vx = pageToView(v, x, 0).x;
      ctx.strokeStyle = '#fff';
      ctx.setLineDash([]);
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(vx, a.y); ctx.lineTo(vx, a.y + rh); ctx.stroke();
      ctx.strokeStyle = '#ff6a00';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(vx, a.y); ctx.lineTo(vx, a.y + rh); ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 3;
    ctx.strokeRect(a.x, a.y, rw, rh);
    ctx.strokeStyle = '#ff6a00';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(a.x, a.y, rw, rh);
    // Shift で軸を固定しているときは、枠の中心を通る補助線を出す
    if (this.drag?.mode === 'move' && this.drag.axis) {
      const c = pageToView(v, r.x + r.w / 2, r.y + r.h / 2);
      ctx.save();
      ctx.setLineDash([5, 5]);
      for (const [color, width] of [['#fff', 3], ['#ff6a00', 1.5]]) {
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.beginPath();
        if (this.drag.axis === 'x') { ctx.moveTo(0, c.y); ctx.lineTo(this.cssW, c.y); }
        else { ctx.moveTo(c.x, 0); ctx.lineTo(c.x, this.cssH); }
        ctx.stroke();
      }
      ctx.restore();
    }
    // 四隅のつまみ
    for (const [hx, hy] of this.cornerPoints()) {
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#0a0a0a';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.rect(hx - 6, hy - 6, 12, 12);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  cornerPoints() {
    const r = this.rect;
    const pts = [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]];
    return pts.map(([x, y]) => {
      const p = pageToView(this.view, x, y);
      return [p.x, p.y];
    });
  }

  // ---- 操作 ----
  localPoint(e) {
    const b = this.canvas.getBoundingClientRect();
    return { x: e.clientX - b.left, y: e.clientY - b.top };
  }

  hitCorner(pt) {
    if (!this.rect) return -1;
    const corners = this.cornerPoints();
    for (let i = 0; i < 4; i++) {
      if (Math.abs(pt.x - corners[i][0]) <= HANDLE / 2 && Math.abs(pt.y - corners[i][1]) <= HANDLE / 2) return i;
    }
    return -1;
  }

  insideRect(pt) {
    if (!this.rect) return false;
    const p = viewToPage(this.view, pt.x, pt.y);
    const r = this.rect;
    return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
  }

  onPointerDown(e) {
    if (!this.page) return;
    this.canvas.focus({ preventScroll: true });
    this.canvas.setPointerCapture(e.pointerId);
    const pt = this.localPoint(e);
    this.pointers.set(e.pointerId, pt);
    if (this.pointers.size === 2) {
      const [p1, p2] = [...this.pointers.values()];
      this.drag = { mode: 'pinch', dist: Math.hypot(p1.x - p2.x, p1.y - p2.y), mid: mid(p1, p2), view: { ...this.view } };
      return;
    }
    const corner = this.hitCorner(pt);
    if (corner >= 0) {
      const r = this.rect;
      const fx = corner % 2 === 0 ? 1 : 0; // 反対側の隅を固定
      const fy = corner < 2 ? 1 : 0;
      this.drag = { mode: 'resize', anchor: { x: r.x + r.w * fx, y: r.y + r.h * fy, fx, fy } };
    } else if (this.insideRect(pt)) {
      this.drag = { mode: 'move', start: viewToPage(this.view, pt.x, pt.y), rect: { ...this.rect }, last: pt };
    } else {
      this.drag = { mode: 'pan', start: pt, view: { ...this.view } };
    }
    this.canvas.classList.add('is-dragging');
  }

  onPointerMove(e) {
    const pt = this.localPoint(e);
    if (!this.drag) {
      this.canvas.style.cursor = this.hitCorner(pt) >= 0 ? 'nwse-resize' : this.insideRect(pt) ? 'move' : 'grab';
      return;
    }
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.set(e.pointerId, pt);
    const d = this.drag;
    if (d.mode === 'pinch' && this.pointers.size >= 2) {
      const [p1, p2] = [...this.pointers.values()];
      const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
      const m = mid(p1, p2);
      let view = zoomViewAt(d.view, dist / d.dist, d.mid.x, d.mid.y);
      view = { ...view, originX: view.originX - (m.x - d.mid.x) / view.scale, originY: view.originY - (m.y - d.mid.y) / view.scale };
      this.view = view;
      this.userView = true;
      this.draw();
    } else if (d.mode === 'pan') {
      this.userView = true;
      this.view = { ...d.view, originX: d.view.originX - (pt.x - d.start.x) / d.view.scale, originY: d.view.originY - (pt.y - d.start.y) / d.view.scale };
      this.draw();
    } else if (d.mode === 'move') {
      d.last = pt;
      this.applyMove(e.shiftKey);
    } else if (d.mode === 'resize') {
      const p = viewToPage(this.view, pt.x, pt.y);
      const a = d.anchor;
      const wx = Math.abs(p.x - a.x);
      const wy = Math.abs(p.y - a.y) / this.aspect;
      this.rect = resizeRect(this.rect, Math.max(wx, wy), this.aspect, a, this.page.width, this.page.height);
      this.draw();
      this.dispatchEvent(new CustomEvent('change', { detail: { rect: this.rect, commit: false } }));
    }
  }

  // 枠の移動。shift が真なら水平か垂直に固定する（ドラッグ開始点からの移動量で判定）
  applyMove(shift) {
    const d = this.drag;
    const p = viewToPage(this.view, d.last.x, d.last.y);
    let dx = p.x - d.start.x;
    let dy = p.y - d.start.y;
    d.axis = null;
    if (shift) ({ dx, dy, axis: d.axis } = lockAxis(dx, dy));
    this.rect = moveRect(d.rect, dx, dy, this.page.width, this.page.height);
    this.draw();
    this.dispatchEvent(new CustomEvent('change', { detail: { rect: this.rect, commit: false } }));
  }

  onPointerUp(e) {
    this.pointers.delete(e.pointerId);
    if (!this.drag) return;
    const mode = this.drag.mode;
    if (this.pointers.size === 0 || mode === 'pinch') {
      this.drag = null;
      this.canvas.classList.remove('is-dragging');
      if (mode === 'move' || mode === 'resize') this.setRect(this.rect, { commit: true });
      else this.afterViewChange();
    }
  }

  onWheel(e) {
    // 通常のホイールはページのスクロールに使う。Ctrl/⌘＋ホイールとトラックパッドのピンチ（ctrlKey付き）で拡大縮小。
    if (!this.page || !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const pt = this.localPoint(e);
    this.userView = true;
    const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
    this.view = zoomViewAt(this.view, factor, pt.x, pt.y);
    this.draw();
    this.scheduleDetail();
  }

  // 矢印: 0.1mm移動（Shiftで1mm）。[ ]: 幅を0.1mm縮小/拡大（Shiftで1mm）。+ -: 表示拡大縮小。0: 全体表示。
  onKey(e) {
    if (!this.page || !this.rect) return;
    const step = (e.shiftKey ? 1 : 0.1) * PT_PER_MM;
    let handled = true;
    const r = this.rect;
    switch (e.key) {
      case 'ArrowLeft': this.setRect(moveRect(r, -step, 0, this.page.width, this.page.height)); break;
      case 'ArrowRight': this.setRect(moveRect(r, step, 0, this.page.width, this.page.height)); break;
      case 'ArrowUp': this.setRect(moveRect(r, 0, -step, this.page.width, this.page.height)); break;
      case 'ArrowDown': this.setRect(moveRect(r, 0, step, this.page.width, this.page.height)); break;
      case '[': this.setRect(scaleRectAroundCenter(r, (r.w - step) / r.w, this.aspect, this.page.width, this.page.height)); break;
      case ']': this.setRect(scaleRectAroundCenter(r, (r.w + step) / r.w, this.aspect, this.page.width, this.page.height)); break;
      case '+': case '=': this.zoomBy(1.25); break;
      case '-': case '_': this.zoomBy(0.8); break;
      case '0': this.fitToPage(); break;
      default: handled = false;
    }
    if (handled) e.preventDefault();
  }

  destroy() {
    this.resizeObserver.disconnect();
    window.removeEventListener('keydown', this.onShift);
    window.removeEventListener('keyup', this.onShift);
    clearTimeout(this.detailTimer);
    this.releaseDetail();
  }
}

function mid(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
