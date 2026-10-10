// `npm run eval:extract:photos -- <flow> [flow ...]` — turns the Word-rendered
// PDF of every photo entry of `eval/extract/<flow>/expected.json` (an entry
// whose `file` ends in `.jpg`) into the phone-photo-like JPEG the eval feeds
// through the real intake and consent path (T-25). The HTML under `<flow>/src`
// is the source of truth; `scripts/eval-extract-docs.ps1 -Flow <flow>` renders
// it to `<name>.pdf` first, and this script then rasterizes page 1, lays it on
// a warm paper background with a slight tilt and a soft shadow, writes
// `<name>.jpg` and deletes the intermediate PDF.
//
// An entry may tune the look with `photo: { rotateDeg, quality }` (a steeper
// tilt and heavier compression make a harder photo, e.g. grn-03).
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { PDFParse } from 'pdf-parse';

const RASTER_WIDTH_PX = 1600;
const PAPER_COLOR = '#efe8d9';
const DEFAULT_ROTATE_DEG = 1.2;
const DEFAULT_QUALITY = 82;
/** Extra room around the page so the tilted corners and the shadow stay inside the photo. */
const MARGIN_FACTOR = 1.14;

interface ExpectedDoc {
  file?: string;
  text?: string;
  photo?: { rotateDeg?: number; quality?: number };
}

async function renderPhoto(pdfPath: string, rotateDeg: number, quality: number): Promise<Buffer> {
  const bytes = new Uint8Array(readFileSync(pdfPath));
  const parser = new PDFParse({ data: bytes });
  let png: Uint8Array;
  try {
    const shot = await parser.getScreenshot({ first: 1, desiredWidth: RASTER_WIDTH_PX, imageDataUrl: false });
    const first = shot.pages[0];
    if (!first) throw new Error(`${pdfPath} has no pages`);
    png = first.data;
  } finally {
    await parser.destroy();
  }

  const page = await loadImage(Buffer.from(png));
  const width = Math.round(page.width * MARGIN_FACTOR);
  const height = Math.round(page.height * MARGIN_FACTOR);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = PAPER_COLOR;
  ctx.fillRect(0, 0, width, height);

  ctx.save();
  ctx.translate(width / 2, height / 2);
  ctx.rotate((rotateDeg * Math.PI) / 180);
  ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
  ctx.shadowBlur = 28;
  ctx.shadowOffsetX = 6;
  ctx.shadowOffsetY = 10;
  ctx.drawImage(page, -page.width / 2, -page.height / 2);
  ctx.restore();

  return canvas.toBuffer('image/jpeg', quality);
}

async function main(): Promise<void> {
  const flows = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  if (flows.length === 0) throw new Error('usage: eval-extract-photos.ts <flow> [flow ...]');

  for (const flow of flows) {
    const dir = path.join(process.cwd(), 'eval', 'extract', flow);
    const expected = JSON.parse(readFileSync(path.join(dir, 'expected.json'), 'utf8')) as ExpectedDoc[];
    for (const doc of expected) {
      if (!doc.file || !/\.jpe?g$/i.test(doc.file)) continue;
      const base = doc.file.replace(/\.jpe?g$/i, '');
      const pdfPath = path.join(dir, `${base}.pdf`);
      if (!existsSync(pdfPath)) {
        throw new Error(`${pdfPath} is missing — run scripts/eval-extract-docs.ps1 -Flow ${flow} first`);
      }
      const rotateDeg = doc.photo?.rotateDeg ?? DEFAULT_ROTATE_DEG;
      const quality = doc.photo?.quality ?? DEFAULT_QUALITY;
      const jpeg = await renderPhoto(pdfPath, rotateDeg, quality);
      const outPath = path.join(dir, doc.file);
      writeFileSync(outPath, jpeg);
      unlinkSync(pdfPath);
      console.log(`${flow}/${base}.pdf -> ${doc.file} (${jpeg.length} bytes, rotate ${rotateDeg}°, quality ${quality})`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
