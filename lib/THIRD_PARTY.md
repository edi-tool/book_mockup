# 同梱ライブラリ

外部CDNを使わず、このディレクトリから同一オリジンで読み込む。更新時は版・取得元・SHA-256をここに記録する。

| ライブラリ | 版 | ライセンス | 取得元 | 同梱ファイル |
|---|---|---|---|---|
| PDF.js（pdfjs-dist） | 6.5.438（2026-11-01公開） | Apache-2.0（`pdfjs/LICENSE`） | npm `pdfjs-dist@6.5.438` | `build/pdf.min.mjs`、`build/pdf.worker.min.mjs`、`cmaps/`、`standard_fonts/`、`iccs/`、`wasm/`（jbig2・openjpeg・qcms と各LICENSE） |
| Three.js（three） | 0.187.0（r187、2026-10-30公開） | MIT（`three/LICENSE`） | npm `three@0.187.0` | `build/three.module.js`、`build/three.core.js` |

同梱しないもの: PDF.js の viewer・sandbox（`pdf.sandbox`）・`quickjs-eval`（PDF内JavaScriptを実行しないため）、`pdf.renderer`。

## SHA-256

```
3a88402882cfa3e7e72c2c9b5149f52f0f88baf1c5b62aa11a41abdbc2072440  pdfjs/pdf.min.mjs
1e64c8240e54735ec5913b37acd5134747799cb8c6bb3777c70adbc01232d2aa  pdfjs/pdf.worker.min.mjs
104f56145899722094556490d787aae0617cc2fc3382f31df02d724ea1aee341  three/three.module.js
613e370f76638fdef83926642bf256dc9615684922de1ce1f63a8583e5d78578  three/three.core.js
```

## 参考にしたコード（同梱なし）

- [CommonerOfWestWall/book-3d-generator](https://github.com/CommonerOfWestWall/book-3d-generator)（MIT License, Copyright (c) 2024-present CommonerOfWestWall、2026-10-12 の main `12cdec8` を参照）
  - `renderer/index.html` の `addPaperbackCore`・`makePageTex`/`makePageTexH`・`applySpineShadow`・`configureImageTexture`・`disposeBook` の構成を `js/book-renderer.js` に書き直して利用。
  - 改変: ES Modules化、Three.js r128 の `encoding` を r187 の `colorSpace` へ、mm単位の外寸維持、綴じ方向別のUV検証、カメラ基準の弱い陰影、射影行列による構図合わせ、`toDataURL`→`toBlob`、Tauri/Electron・視点保存は移植しない。
  - 角度プリセット（`data-az`/`data-el`）は値の目安として参照し、`js/views.js` で独自に定義。

以下は book-3d-generator の MIT License 全文。

```
MIT License

Copyright (c) 2024-present CommonerOfWestWall

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [edi-tool/kokuban-adjust](https://github.com/edi-tool/kokuban-adjust)（MIT）: 表示座標と原寸の分離、Pointer Events、Blob保存とメモリ解放、共通の上部バー・アイコンCSS、静的検査の構成を参考にした。
