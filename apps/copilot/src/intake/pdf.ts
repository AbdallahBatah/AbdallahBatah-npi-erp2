// PDF analysis for document intake (spec/madar/02 §5.2): decide whether a
// PDF carries extractable text or must be treated as scanned (rasterized to
// PNG pages so a vision-capable model can read it later). Node-only; no
// special Jest setup is needed in production — pdf-parse's dynamic worker
// import only needs help under Jest (see tests/helpers/pdfjs-env.js).
import { FormatError, InvalidPDFException, PasswordException, PDFParse } from 'pdf-parse';

export const PDF_TEXT_MIN_CHARS = 50;
export const PDF_RASTER_MAX_PAGES = 5;
export const PDF_RASTER_WIDTH_PX = 1600;

export interface PdfPageText {
  num: number;
  text: string;
}

export interface PdfPagePng {
  num: number;
  width: number;
  height: number;
  png: Uint8Array;
}

export type PdfAnalysis =
  | { kind: 'pdf_text'; pageCount: number; pages: PdfPageText[]; text: string; textChars: number }
  | { kind: 'pdf_scanned'; pageCount: number; pages: PdfPagePng[] };

export type PdfReadErrorKind = 'invalid' | 'encrypted' | 'empty';

export class PdfReadError extends Error {
  readonly kind: PdfReadErrorKind;
  constructor(kind: PdfReadErrorKind, message?: string) {
    super(message ?? kind);
    this.name = 'PdfReadError';
    this.kind = kind;
  }
}

function isExceptionNamed(err: unknown, ctor: new (...args: never[]) => Error, name: string): boolean {
  if (err instanceof ctor) return true;
  // The bundled exception classes may not be the same identity as the ones
  // this module imported (e.g. a different copy loaded by a worker), so fall
  // back to comparing `name`.
  return err instanceof Error && err.name === name;
}

function toPdfReadError(err: unknown): PdfReadError {
  if (isExceptionNamed(err, PasswordException, 'PasswordException')) {
    return new PdfReadError('encrypted', err instanceof Error ? err.message : undefined);
  }
  if (
    isExceptionNamed(err, InvalidPDFException, 'InvalidPDFException') ||
    isExceptionNamed(err, FormatError, 'FormatError')
  ) {
    return new PdfReadError('invalid', err instanceof Error ? err.message : undefined);
  }
  // Anything else pdf-parse/pdfjs throws is still an unreadable PDF as far
  // as intake is concerned.
  return new PdfReadError('invalid', err instanceof Error ? err.message : String(err));
}

export async function analyzePdf(data: Uint8Array): Promise<PdfAnalysis> {
  // pdfjs transfers the typed array to its worker port and detaches the
  // caller's buffer (LoadParameters.data: "taking ownership of the array").
  // The caller still needs its bytes afterwards (hashing, storage), so the
  // parser gets a private copy. Seen live: "Cannot perform Construct on a
  // detached ArrayBuffer" when the upload was written to disk after parsing.
  const parser = new PDFParse({ data: new Uint8Array(data) });
  try {
    let total: number;
    try {
      const info = await parser.getInfo();
      total = info.total;
    } catch (err) {
      throw toPdfReadError(err);
    }

    if (total === 0) throw new PdfReadError('empty');

    let textResult;
    try {
      textResult = await parser.getText({ pageJoiner: '' });
    } catch (err) {
      throw toPdfReadError(err);
    }

    const textChars = textResult.text.replace(/\s+/g, ' ').trim().length;

    if (textChars >= PDF_TEXT_MIN_CHARS) {
      return {
        kind: 'pdf_text',
        pageCount: total,
        pages: textResult.pages.map((page) => ({ num: page.num, text: page.text.replace(/\n$/, '') })),
        text: textResult.text,
        textChars,
      };
    }

    let screenshot;
    try {
      screenshot = await parser.getScreenshot({
        first: Math.min(total, PDF_RASTER_MAX_PAGES),
        desiredWidth: PDF_RASTER_WIDTH_PX,
        imageDataUrl: false,
      });
    } catch (err) {
      throw toPdfReadError(err);
    }

    return {
      kind: 'pdf_scanned',
      pageCount: total,
      pages: screenshot.pages.map((page) => ({
        num: page.pageNumber,
        width: page.width,
        height: page.height,
        png: page.data,
      })),
    };
  } finally {
    await parser.destroy();
  }
}
