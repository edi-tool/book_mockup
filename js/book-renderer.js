// 並製本・単冊の3D描画（Three.js r187）。
// 構成（表紙の板・背・紙束の6面、紙目テクスチャ、背の陰影、テクスチャ設定、破棄処理）は
// CommonerOfWestWall/book-3d-generator（MIT, Copyright (c) 2024-present CommonerOfWestWall）の
// renderer/index.html の addPaperbackCore / makePageTex / makePageTexH / applySpineShadow /
// configureImageTexture / disposeBook を参考に、ES Modules と現行の colorSpace API へ書き直した。
// 主な改変: 寸法をmmで厳密化（外寸 W×H×S を維持）、面ごとのUV向きを綴じ方向で検証、
// 光はカメラ基準の弱い固定陰影（正面は元絵の色のまま）、構図合わせを射影行列で行う、toDataURLをやめtoBlobへ。
import * as THREE from '../lib/three/three.module.js';
import {
  cameraDirection, boxCorners, fitTransform, applyFitToMatrix, faceBrightness, PERSPECTIVE_FOV, FIT_MARGIN,
} from './views.js';

const PAPER = '#f6f3ec';
const PAPER_LINE = '#ddd6c8';

export function webgl2Available() {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    const ok = Boolean(gl);
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return ok;
  } catch {
    return false;
  }
}

export class BookRenderer {
  constructor({ onContextLost, onContextRestored } = {}) {
    this.canvas = document.createElement('canvas');
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
      onContextLost?.();
    });
    this.canvas.addEventListener('webglcontextrestored', () => {
      this.lost = false;
      onContextRestored?.();
    });
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.setPixelRatio(1);
    this.renderer.setClearColor(0x000000, 0);
    const gl = this.renderer.getContext();
    this.maxTextureSize = this.renderer.capabilities.maxTextureSize;
    this.maxRenderSize = Math.min(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), ...gl.getParameter(gl.MAX_VIEWPORT_DIMS));
    this.scene = new THREE.Scene();
    this.group = null;
    this.faceMaterials = []; // { material, normal: [x,y,z] }
    this.dims = null;
  }

  // dims: { W, H, S }（mm）、binding: 'left'|'right'、textures: { front, spine, back }（canvas）
  setBook(dims, binding, textures) {
    this.clearBook();
    const { W, H, S } = dims;
    this.dims = dims;
    const side = binding === 'right' ? 1 : -1; // 背のある側の X 符号
    const t = Math.min(0.3, S * 0.2); // 表紙の厚み
    const e = Math.min(0.4, S * 0.15); // 紙束の天・地・小口の引っ込み
    const g = new THREE.Group();
    const anis = Math.min(16, this.renderer.capabilities.getMaxAnisotropy());
    const tex = (canvas) => {
      const tx = new THREE.CanvasTexture(canvas);
      tx.colorSpace = THREE.SRGBColorSpace;
      tx.wrapS = tx.wrapT = THREE.ClampToEdgeWrapping;
      tx.anisotropy = anis;
      tx.generateMipmaps = true;
      tx.minFilter = THREE.LinearMipmapLinearFilter;
      tx.magFilter = THREE.LinearFilter;
      return tx;
    };
    const edgeColor = new THREE.Color(PAPER);
    const mat = (normal, opts) => {
      const m = new THREE.MeshBasicMaterial(opts);
      this.faceMaterials.push({ material: m, normal });
      return m;
    };
    const boxMaterials = (overrides, base) => {
      const normals = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
      return normals.map((n, i) => overrides[i] ?? mat(n, { color: base.clone() }));
    };

    // 背表紙（外面に背のテクスチャ）。表紙の板と重ならないよう幅 t、奥行き S 全体。
    const spineGeo = new THREE.BoxGeometry(t, H, S, 1, 1, 24);
    applySpineShade(spineGeo, S);
    const spineFace = side < 0 ? 1 : 0; // nx / px
    const spineMat = mat(side < 0 ? [-1, 0, 0] : [1, 0, 0], { map: tex(textures.spine), vertexColors: true });
    const spineMesh = new THREE.Mesh(spineGeo, boxMaterials({ [spineFace]: spineMat }, edgeColor));
    spineMesh.position.set(side * (W / 2 - t / 2), 0, 0);
    g.add(spineMesh);

    // 表1・表4の板（幅 W - t）。BoxGeometry の +Z / -Z 面は外から見て正立・非鏡像になる。
    const boardW = W - t;
    const boardX = -side * (t / 2);
    const front = new THREE.Mesh(new THREE.BoxGeometry(boardW, H, t), boxMaterials({ 4: mat([0, 0, 1], { map: tex(textures.front) }) }, edgeColor));
    front.position.set(boardX, 0, S / 2 - t / 2);
    g.add(front);
    const back = new THREE.Mesh(new THREE.BoxGeometry(boardW, H, t), boxMaterials({ 5: mat([0, 0, -1], { map: tex(textures.back) }) }, edgeColor));
    back.position.set(boardX, 0, -(S / 2 - t / 2));
    g.add(back);

    // 紙束（天・地・小口に紙目）
    const blockW = W - t - e;
    const blockH = H - e * 2;
    const blockD = Math.max(0.01, S - t * 2);
    const foreTex = tex(makePaperTexture(Math.max(8, Math.min(1024, Math.round(blockD * 12))), 512, 'vertical'));
    const topTex = tex(makePaperTexture(512, Math.max(8, Math.min(1024, Math.round(blockD * 12))), 'horizontal'));
    foreTex.userData.owned = true;
    topTex.userData.owned = true;
    const foreFace = side < 0 ? 0 : 1; // 小口は背の反対側
    const block = new THREE.Mesh(
      new THREE.BoxGeometry(blockW, blockH, blockD),
      boxMaterials({
        [foreFace]: mat(side < 0 ? [1, 0, 0] : [-1, 0, 0], { map: foreTex }),
        2: mat([0, 1, 0], { map: topTex }),
        3: mat([0, -1, 0], { map: topTex }),
      }, edgeColor),
    );
    // 背の内側から小口側へ blockW。小口は表紙より e だけ引っ込む。
    block.position.set(side * (W / 2 - t) - side * (blockW / 2), 0, 0);
    g.add(block);

    this.group = g;
    this.scene.add(g);
  }

  clearBook() {
    if (!this.group) return;
    this.scene.remove(this.group);
    const geometries = new Set(), materials = new Set(), textures = new Set();
    this.group.traverse((obj) => {
      if (obj.geometry) geometries.add(obj.geometry);
      (Array.isArray(obj.material) ? obj.material : [obj.material]).filter(Boolean).forEach((m) => {
        materials.add(m);
        if (m.map) textures.add(m.map);
      });
    });
    // 面の canvas は呼び出し側の持ち物なので解放しない（紙目の canvas だけ解放）
    textures.forEach((t) => {
      if (t.userData.owned && t.image) {
        t.image.width = 0;
        t.image.height = 0;
      }
      t.dispose();
    });
    materials.forEach((m) => m.dispose());
    geometries.forEach((g) => g.dispose());
    this.group = null;
    this.faceMaterials = [];
  }

  // view: resolveView() の戻り値。size: 出力の一辺 px。透明背景の本だけを描いた canvas を返す（呼び出し側で合成）。
  render(view, size) {
    if (!this.group) throw new Error('本のモデルがありません。');
    if (this.lost) throw new Error('WebGLの描画が中断されました。');
    if (size > this.maxRenderSize) throw new Error(`この端末では${this.maxRenderSize}pxまでしか描画できません。`);
    const { W, H, S } = this.dims;
    const radius = Math.hypot(W, H, S) / 2;
    const dir = cameraDirection(view.yaw, view.pitch);
    let camera;
    if (view.projection === 'ortho') {
      camera = new THREE.OrthographicCamera(-radius, radius, radius, -radius, radius * 0.1, radius * 6);
      camera.position.set(dir[0] * radius * 3, dir[1] * radius * 3, dir[2] * radius * 3);
    } else {
      const dist = radius / Math.sin((PERSPECTIVE_FOV * Math.PI) / 360) * 1.05;
      camera = new THREE.PerspectiveCamera(PERSPECTIVE_FOV, 1, dist * 0.2, dist * 3);
      camera.position.set(dir[0] * dist, dir[1] * dist, dir[2] * dist);
    }
    camera.up.set(0, 1, 0);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();

    // 光（カメラ基準）で各面の明るさを決める
    const m = camera.matrixWorld.elements;
    const right = [m[0], m[1], m[2]];
    const up = [m[4], m[5], m[6]];
    for (const { material, normal } of this.faceMaterials) {
      const b = faceBrightness(normal, dir, up, right);
      material.color.setRGB(b, b, b, THREE.LinearSRGBColorSpace);
    }

    // 8頂点を投影して余白8%で中央に収める
    const ndc = boxCorners(W, H, S).map(([x, y, z]) => {
      const v = new THREE.Vector3(x, y, z).project(camera);
      return [v.x, v.y];
    });
    const fit = fitTransform(ndc, FIT_MARGIN);
    camera.projectionMatrix.fromArray(applyFitToMatrix(camera.projectionMatrix.toArray(), fit));
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();

    this.renderer.setSize(size, size, false);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.render(this.scene, camera);
    // preserveDrawingBuffer なしでも、同じタスク内ならバッファを複製できる
    const out = document.createElement('canvas');
    out.width = size;
    out.height = size;
    out.getContext('2d').drawImage(this.canvas, 0, 0);
    return out;
  }

  dispose() {
    this.clearBook();
    this.renderer.dispose();
    this.renderer.forceContextLoss?.();
  }
}

// 背の丸みを思わせる弱い陰影（頂点色）。中央1.0、両端0.88。
function applySpineShade(geo, depth) {
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const z = pos.getZ(i) / (depth / 2);
    const tint = 1 - 0.12 * z * z;
    colors.set([tint, tint, tint], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

// 紙の断面。乱数は固定シードで毎回同じ模様にする（決定論的）。
function makePaperTexture(w, h, direction) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, w, h);
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const n = direction === 'vertical' ? w : h;
  for (let i = 0; i < n; i += 2) {
    ctx.globalAlpha = 0.25 + rand() * 0.35;
    ctx.fillStyle = PAPER_LINE;
    if (direction === 'vertical') ctx.fillRect(i, 0, 1, h);
    else ctx.fillRect(0, i, w, 1);
  }
  ctx.globalAlpha = 1;
  return c;
}
