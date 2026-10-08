// `npm run eval:extract:scans -- <flow> [flow ...]` — builds the scanned-PDF
// variants of `eval/extract/<flow>/expected.json` (T-36; 03 §6 asks for two
// scanned contracts among the six). An entry with `scan: { source }` names a
// text PDF of the same flow (`contract-01.pdf`); this script rasterizes every
// page of that PDF through pdf-parse, lays each page on grey paper with a
// slight tilt, compresses it to JPEG and writes the pages back as an
// image-only PDF (`contract-01-scan.pdf`) with no text layer at all — the form
// a desk scanner or a phone's «scan to PDF» produces. `analyzePdf` then
// classifies it `pdf_scanned` (fewer than PDF_TEXT_MIN_CHARS characters) and
// the eval feeds it through the real intake + consent path like a photo.
//
// The PDF is written by hand (catalog, page tree, one DCTDecode image XObject
// per page, one content stream per page, xref) so that no PDF-writing
// dependency is added: pdf-parse and @napi-rs/canvas are already in the tree.
//
// An entry may tune the look with `scan: { rotateDeg, quality }`.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { PDFParse } from 'pdf-parse';

const RASTER_WIDTH_PX = 1600;
const PAPER_COLOR = '#f1efe9';
const DEFAULT_ROTATE_DEG = 0.7;
const DEFAULT_QUALITY = 72;
/** A4 in PDF points; every page image is stretched onto it. */
const PAGE_W_PT = 595.28;
const PAGE_H_PT = 841.89;

interface ExpectedDoc {
  file?: string;
  text?: string;
  scan?: { source: string; rotateDeg?: number; quality?: number };
}

async function rasterizePages(pdfPath: string): Promise<Uint8Array[]> {
  const bytes = new Uint8Array(readFileSync(pdfPath));
  const parser = new PDFParse({ data: bytes });
  try {
    const info = await parser.getInfo();
    const shot = await parser.getScreenshot({ first: info.total, desiredWidth: RASTER_WIDTH_PX, imageDataUrl: false });
    if (shot.pages.length === 0) throw new Error(`${pdfPath} has no pages`);
    return shot.pages.map((p) => p.data);
  } finally {
    await parser.destroy();
  }
}

async function scanLook(png: Uint8Array, rotateDeg: number, quality: number): Promise<{ jpeg: Buffer; width: number; height: number }> {
  const page = await loadImage(Buffer.from(png));
  const canvas = createCanvas(page.width, page.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = PAPER_COLOR;
  ctx.fillRect(0, 0, page.width, page.height);
  ctx.save();
  ctx.translate(page.width / 2, page.height / 2);
  ctx.rotate((rotateDeg * Math.PI) / 180);
  // A scanner crops slightly inside the sheet: scale the page down a touch so
  // the tilted corners stay on the paper.
  const scale = 0.985;
  ctx.drawImage(page, (-page.width / 2) * scale, (-page.height / 2) * scale, page.width * scale, page.height * scale);
  ctx.restore();
  return { jpeg: canvas.toBuffer('image/jpeg', quality), width: page.width, height: page.height };
}

/** One image-only PDF page per JPEG; objects are numbered in order of appearance. */
function buildImagePdf(pages: { jpeg: Buffer; width: number; height: number }[]): Buffer {
  const chunks: Buffer[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (part: Buffer | string): void => {
    const buf = typeof part === 'string' ? Buffer.from(part, 'latin1') : part;
    chunks.push(buf);
    length += buf.length;
  };
  const object = (num: number, body: Buffer | string): void => {
    offsets[num] = length;
    push(`${num} 0 obj\n`);
    push(body);
    push('\nendobj\n');
  };

  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  // 1 catalog, 2 pages; then per page i (0-based): page 3+3i, image 4+3i, content 5+3i.
  const pageIds = pages.map((_, i) => 3 + 3 * i);
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  pages.forEach((page, i) => {
    const pageId = 3 + 3 * i;
    const imageId = pageId + 1;
    const contentId = pageId + 2;
    object(
      pageId,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W_PT} ${PAGE_H_PT}] /Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`,
    );
    object(
      imageId,
      Buffer.concat([
        Buffer.from(
          `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`,
          'latin1',
        ),
        page.jpeg,
        Buffer.from('\nendstream', 'latin1'),
      ]),
    );
    const content = `q ${PAGE_W_PT} 0 0 ${PAGE_H_PT} 0 0 cm /Im0 Do Q`;
    object(contentId, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });

  const count = 3 + 3 * pages.length;
  const xrefAt = length;
  push(`xref\n0 ${count}\n`);
  push('0000000000 65535 f \n');
  for (let num = 1; num < count; num += 1) push(`${String(offsets[num]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);
  return Buffer.concat(chunks);
}

async function main(): Promise<void> {
  const flows = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  if (flows.length === 0) throw new Error('usage: eval-extract-scans.ts <flow> [flow ...]');

  for (const flow of flows) {
    const dir = path.join(process.cwd(), 'eval', 'extract', flow);
    const expected = JSON.parse(readFileSync(path.join(dir, 'expected.json'), 'utf8')) as ExpectedDoc[];
    for (const doc of expected) {
      if (!doc.file || !doc.scan) continue;
      const sourcePath = path.join(dir, doc.scan.source);
      if (!existsSync(sourcePath)) throw new Error(`${sourcePath} is missing — render the flow's sources first (scripts/eval-extract-docs.ps1)`);
      const rotateDeg = doc.scan.rotateDeg ?? DEFAULT_ROTATE_DEG;
      const quality = doc.scan.quality ?? DEFAULT_QUALITY;
      const pngs = await rasterizePages(sourcePath);
      const pages = [];
      for (const png of pngs) pages.push(await scanLook(png, rotateDeg, quality));
      const pdf = buildImagePdf(pages);
      const outPath = path.join(dir, doc.file);
      writeFileSync(outPath, pdf);
      console.log(`${flow}/${doc.scan.source} -> ${doc.file} (${pages.length} pages, ${pdf.length} bytes, rotate ${rotateDeg}°, quality ${quality})`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
