/*
SPDX-License-Identifier: Apache-2.0
Copyright 2026 ISHIKAWA, Natsuki
Project: edi-tool
Source: https://github.com/edi-tool
Applies to original code; third-party materials and separately licensed content retain their terms.
*/
// PDF.js の薄いラッパー。PDFは端末内で処理し、外部へ送らない。
import * as pdfjs from '../lib/pdfjs/pdf.min.mjs';

const LIB = new URL('../lib/pdfjs/', import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.mjs', LIB).href;

export class PdfError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function looksLikePdf(bytes) {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(1024, bytes.length)));
  return head.includes('%PDF-');
}

export async function openPdf(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  if (!looksLikePdf(bytes)) throw new PdfError('not-pdf', 'PDFファイルではないようです。');
  const task = pdfjs.getDocument({
    data: bytes,
    cMapUrl: new URL('cmaps/', LIB).href,
    cMapPacked: true,
    standardFontDataUrl: new URL('standard_fonts/', LIB).href,
    wasmUrl: new URL('wasm/', LIB).href,
    iccUrl: new URL('iccs/', LIB).href,
    enableXfa: false,
    stopAtErrors: false,
  });
  // パスワード要求はキャンセルして暗号化エラーとして扱う
  task.onPassword = () => task.destroy();
  try {
    const doc = await task.promise;
    return new PdfDocument(doc, task);
  } catch (err) {
    await task.destroy().catch(() => {});
    throw classifyError(err);
  }
}

export function classifyError(err) {
  if (err instanceof PdfError) return err;
  const name = err?.name || '';
  if (name === 'PasswordException' || /password/i.test(err?.message || '')) {
    return new PdfError('encrypted', 'パスワード付き（暗号化）PDFは開けません。保護を外したPDFを選んでください。');
  }
  if (name === 'InvalidPDFException' || name === 'FormatError') {
    return new PdfError('broken', 'PDFが壊れているか、読み取れない形式です。');
  }
  if (name === 'RenderingCancelledException' || name === 'AbortException' || err?.code === 'cancelled') {
    return new PdfError('cancelled', '処理を中止しました。');
  }
  return new PdfError('unknown', `PDFを処理できませんでした（${name || 'Error'}）。`);
}

export class PdfDocument {
  constructor(doc, task) {
    this.doc = doc;
    this.task = task;
    this.numPages = doc.numPages;
    this.pages = new Map();
  }

  async page(pageNumber) {
    if (!this.pages.has(pageNumber)) this.pages.set(pageNumber, this.doc.getPage(pageNumber));
    try {
      return await this.pages.get(pageNumber);
    } catch (err) {
      this.pages.delete(pageNumber);
      throw classifyError(err);
    }
  }

  // ページの寸法（viewport scale=1、UserUnit・CropBox・回転込み）
  async pageInfo(pageNumber, extraRotation = 0) {
    const page = await this.page(pageNumber);
    const rotation = (page.rotate + extraRotation) % 360;
    const vp = page.getViewport({ scale: 1, rotation });
    return { width: vp.width, height: vp.height, rotation, userUnit: page.userUnit ?? 1 };
  }

  // ページの矩形 region（scale=1の座標）を outW×outH の canvas に描く。signal で中止できる。
  async renderRegion(pageNumber, rotation, region, outW, outH, signal) {
    const page = await this.page(pageNumber);
    const s = outW / region.w;
    const viewport = page.getViewport({ scale: s, rotation, offsetX: -region.x * s, offsetY: -region.y * s });
    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, outW, outH);
    // 縦方向の丸め誤差を吸収する（outH / (region.h * s)、ほぼ1）
    const sy = outH / (region.h * s);
    const task = page.render({
      canvas,
      canvasContext: ctx,
      viewport,
      transform: Math.abs(sy - 1) > 1e-9 ? [1, 0, 0, sy, 0, 0] : undefined,
      annotationMode: pdfjs.AnnotationMode.DISABLE,
      background: '#ffffff',
    });
    const abort = () => task.cancel();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      if (signal?.aborted) task.cancel();
      await task.promise;
      return canvas;
    } catch (err) {
      canvas.width = 0;
      canvas.height = 0;
      throw classifyError(err);
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  async destroy() {
    this.pages.clear();
    await this.task.destroy().catch(() => {});
  }
}
