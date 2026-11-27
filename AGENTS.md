# book_mockup
実装前に docs/SPEC.md と docs/ACCEPTANCE.md を読む。
共通方針 https://github.com/edi-tool/.github/blob/main/PRINCIPLES.md
共通デザイン https://github.com/edi-tool/.github/blob/main/DESIGN.md
- GitHub Pages / Vanilla JS ES Modules / ビルド不要を優先。PDF.js・Three.jsは例外。安定版固定・ローカル同梱・ライセンス明記。
- 実行時AI・外部API・CDN・解析タグ・PDF送信禁止。実PDF・生成書影・ローカルパス・ファイル名を公開repoやログに入れない。
- 判型は指定値 B5 182×257、A5 148×210、四六 127×188 mm。背幅手入力。自動置換しない。
- 元PDFから高精細再描画。表1/背/表4の方向と寸法を守る。プレビュー拡大保存禁止。色差・縮小は明示。
- 実装前にローカルPDFの構造を調べる。公開テストは合成素材のみ。
- Windows Chrome/Edge、iPhone Safari、キーボード操作、メモリ解放、非同期競合、WebGL2非対応時を確認。
- 共通CI・静的チェックを実装と同時導入。Node22、node:test。検証をまとめてからpush。実装は作業ブランチ・PR。
- CHANGELOG.md、progress.mdを更新。実装後予定: python -m http.server 8000 / npm test / npm run check。
