# MVP 要件・技術設計（2026-11-26）
実装前・実PDF未確認。ユーザー未指定の事項は暫定提案。
## 目的
印刷用展開カバーPDFを直接使い、販促・EC用の立体書影を作る。Pacdora/PSDのような質感を目標に、実行時はAI、Photoshop、外部API、サーバーを一切使わない。元絵のテクスチャと3D形状・光・カメラによる決定論的な描画（GPU間のバイト一致は保証しない）。色校正・印刷入稿は非目標。
## P0 操作
1. PDF選択/ドロップ。File.arrayBuffer()で端末内処理。複数ページ選択（初期1）、90度回転。破損・暗号化は明示エラー。
2. 判型手動 B5 182×257 / A5 148×210 / 四六 127×188 mm。背幅mm（初期未入力、暫定0.1〜100、0.1刻み）。空/0/負/非有限/範囲外はエラー。左綴じ初期値、右綴じ切替。
3. PDF上に表1＋背＋表4の仕上がり矩形。比率(2W+S):H固定、移動・均等拡縮。左綴じは左から表4・背・表1、右綴じは逆。トンボ・塗り足し・袖を除外。面ラベルと境界、枠外マスク、ズーム/パン/矢印キー微調整/リセット。PDF実寸から初期枠を中央配置し、自動確定しない。寸法差警告。枠はページ内に収める。実PDFに左右非対称等がある場合は独立境界編集の必要性を再検討。
4. 表1・背・表4の平面サムネイルで確認。戻っても設定保持。
5. 3D: 閉じた並製本・単冊。正面、表1＋背、表1＋小口、表4＋背、表4正面、斜め俯瞰。プリセット選択。角度自由調整はP1可。紙束、薄い表紙、控えめな紙目・丸み・柔らかい影。外寸W,H,Sを守る。
6. PNG: 透過既定/白、1200/2000（既定）/3000px正方形、余白約8%、影ON/OFF。プレビューと構図一致。ファイル名＋角度・判型・背幅を出力名に（端末内のみ）。正面は表1を歪ませない。空/白画像を成功扱いしない。
## 座標・解像度
- PDF.js page.getViewport({scale:1,rotation})を論理座標基準。CropBox、回転、原点、UserUnitを考慮。通常1pt=25.4/72mm。ページ・回転・正規化矩形x,y,w,hを保持。CSS、DPR、ズームと分離。
- 横境界 x, x+w*W/(2W+S), x+w*(W+S)/(2W+S), x+w。A5/S16=312×210、B5/S5=369×257、四六/S16=270×188mm。整数画素は累積境界を丸め隙間を防ぐ。
- プレビュー低解像度、出力は元PDFから必要解像度で再描画。大ページは面ごとのクリップrender（viewportと平行移動）。目安300ppi相当を投影画素・上限で調整。埋込画像以上の精細さは保証しない。
- canvas上限（暫定16MP/面）、辺、MAX_TEXTURE_SIZE/MAX_RENDERBUFFER_SIZE、総メモリを確認。縮小時警告。render cancel、古いcanvas/texture/material/geometry/objectURL解放。
- CMYK/ICC/特色/オーバープリント/透明効果/未埋込フォントのRGB再現は色校正ではない。実例確認、制約をUIとREADMEに明記。
## 3D
- Three.jsのBoxGeometry等でW:H:Sを保持。表1=+Z、表4=-Z、左綴じ背=-X、右綴じ背=+X。各面UVを明示し鏡像・倒立防止。天地小口は紙。薄い表紙厚を近似、全外寸維持、z-fighting防止。
- CanvasTexture.colorSpace=SRGBColorSpace。元絵色を優先する弱い陰影、過度な反射/トーンマッピング禁止。紙目は手続き生成。正面正投影、斜めは正投影と望遠相当透視を比較。全頂点投影してfit。
- alpha:true、透明clear、影は別レイヤーで合成可能。出力DPR=1、指定px、render直後にtoBlob。プレビュー復帰。WebGL2不可なら正面Canvas2D保存と明示案内。
- P1品質: 表紙の厚み・紙束境界・微細な角/背の丸み、接触影、光沢/マット切替。自作BlenderモデルをglTFで同梱する方式も比較。固定PSD直接再現は比率/角度の自由度、レイヤー互換性、再配布権から非採用。2Dテンプレート追加なら自作影・マスクと射影変換。AI不要。
## 先行技術（採用順位）
- https://github.com/CommonerOfWestWall/book-3d-generator : README実見。最優先。v1.3.0はTauri 2だがrenderer/index.html、renderer/book-model.js、renderer/three.min.js（r128）、testsに注目。展開画像、背・袖境界、平装/精装、sRGB、背陰影、FOV/視点、透過PNG、複数角度。Tauriを移植せずブラウザ側の構造・角度・テストを比較。古いThree.jsをそのまま採用しない。MIT License（LICENSE本文確認済、Copyright (c) 2024-present CommonerOfWestWall）。renderer/index.htmlとrenderer/book-model.jsも確認済。流用時は著作権表示とMIT全文を保持し出典・改変箇所を明記。具体的な候補は下記。
- https://github.com/sogyeokdong9/3D-Book-Mockup-Using-CSS : README実見。ルートにはREADMEのみ、ライセンスなし。実装コードの流用元にはしない。CSS 3D変形・影・perspectiveの概念参考。DOMからPNGにする際の3D変形/影再現が不確実なので主方式にしない。ライセンス確認前の流用禁止。
- https://www.pacdora.com/jp/tools/3d-book-mockup-generator : 公式ページ確認。判型・製本・背景・角度・PNG出力のUXおよび品質基準。内部技術は未確認。素材・コードをコピーしない。
- https://github.com/edi-tool/kokuban-adjust : README/AGENTS/js/app.js/scanner-adapter.js実見。表示座標と原寸分離、Pointer Events、undo、Blob保存、メモリ解放、静的検査を参考。MIT。平面PDFなのでscanicの自動四隅検出や補正は不要。古い配色ではなく共通DESIGN.md最新版（#f5f5f7/#ff6a00）を採用。
- https://mozilla.github.io/pdf.js/examples/ : viewport座標・canvas描画。PDF.js Apache-2.0。https://threejs.org/docs/pages/WebGLRenderer.html : WebGL2描画。Three.js MIT。バージョン・ライセンスは実装時確認し固定。
- PSDスマートオブジェクト/Freepikは品質見本のみ。再配布・商用利用許諾とブラウザ描画互換性が課題。
## ファイル構成・運用
index.html, styles.css, js/app.js, pdf-adapter.js, crop-geometry.js（純粋関数）, crop-editor.js, book-renderer.js, export.js, lib/（固定版・ライセンス）, tests/, scripts/check-static.mjs, _config.yml, CHANGELOG.md, progress.md。PDF.js workerと本体同版、cMaps/standard_fonts/wasmなど必要データも同一オリジン相対URL。PDF内JavaScript/アクション/外部リンクを実行しない。isEvalSupported:false等を検討。実PDF・設定履歴保存なし。依存の脆弱性確認。共通CIテンプレートと静的検査導入。Pages設定は動作確認後。P1: 任意判型、自由角度、角度一括PNG、上製本、質感追加。P0で後回しにしないのはPDFの範囲精度と元絵の忠実さ。

## book-3d-generator 実コード調査・移植計画
- renderer/index.html: addPaperbackCore（6面PlaneGeometry）、makePageTex/makePageTexH（CanvasTexture紙目）、applySpineShadow（頂点色グラデーション）、configureImageTexture、makeTexMat（MeshBasicMaterial）、fitView/keepProjectionFramed（Box3・投影）、updateCamera、getExportDataURL（DPR=1/背景切替/復元）、disposeBook、waitForTextures、splitCover、moveCropBoundary。対象機能を抽出して小さいES Modulesへ分離。Tauri/Electron/保存ビュー永続化は移植しない。旧r128の色変換APIを現行版のcolorSpace等へ更新し二重変換を避ける。元のpreserveDrawingBuffer常時true・dataURLは必要性を検討しtoBlob優先。
- renderer/book-model.js: hardcoverLayout/buildHardcover。上製本はP1。tests/book-camera.test.cjs, book-model.test.cjs, view-presets.test.cjs, workflow.cjsが検証の参考。公開MITコードを使う場合は該当箇所とライセンスを記録。
- 出典 https://github.com/CommonerOfWestWall/book-3d-generator/blob/main/renderer/index.html / https://github.com/CommonerOfWestWall/book-3d-generator/blob/main/renderer/book-model.js / https://github.com/CommonerOfWestWall/book-3d-generator/blob/main/LICENSE

## 実PDF調査（2026-11-26、ローカルのみ・匿名化）
手元の実カバーPDF2点を公開せずに調査した。ファイル名・書名は記録しない。
- 共通: 1ページ・回転なし・暗号化なし・UserUnitなし。MediaBox=CropBox=BleedBox=TrimBoxが用紙全体で、**PDFのボックスから仕上がりは分からない**（トンボからしか分からない）。トンボは0.1mm程度の黒線、塗り足し3mm、四隅は仕上がり線と塗り足し線の二重、面の境界に折りトンボ。左上にファイル情報の文字がある。
- 見本A: 用紙600×300mm。左綴じ（左から袖・表4・背・表1・袖）。A5で表1/表4とも148.0×210mm、背10.5mm、袖90mm×2。トンボ間の仕上がり幅486.6mm。ICCベースのCMYK画像（600px前後で解像度は高くない）、オーバープリント指定あり。
- 見本B: 用紙500×370mm。右綴じ（左から袖・表1・背・表4・袖）。四六の高さ188mmだが**表1/表4の幅は128mm（指定値127mmより1mm広い）**、背16mm、袖80mm×2。**同じページの下半分に帯（高さ50mm）が配置**されている。透明グループを多数含むベクター主体で、PDF.jsの描画が重い。
- 設計への反映:
  - 枠は「判型の指定値＋背幅」の比率固定のまま（SPECどおり）。見本Bは左右対称なので、指定値の枠を中央に置くと背の位置は一致し、小口側が各1mm内側になるだけ（寸法差0.7%で警告閾値1.5%未満）。独立境界編集は現時点では不要と判断。左右非対称の実例が出たら再検討。
  - 初期枠はページ中央に置く。見本Aは中央配置で仕上がり線と0.1mm以内に一致。見本Bは帯があるため縦位置を手で合わせる必要がある（矢印キーで可能）。
  - 帯は仕上がり枠の外に出して除外する。帯の合成はP1候補。
