// Hand-built, minimal PDF fixtures for exercising the real pdf-parse library
// without checking binary files into the repository. Each fixture builds
// just enough of the PDF object/xref/trailer structure for pdfjs to parse:
// one Pages tree, N Page objects, and either a Helvetica text content stream
// (Latin text only — Helvetica cannot encode Arabic) or a tiny 2x2
// DeviceGray image XObject shared by every page.

function pdf(objects: string[]): Buffer {
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += String(o).padStart(10, '0') + ' 00000 n \n';
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

function escapePdfString(text: string): string {
  return text.replaceAll(/\\/g, '\\\\').replaceAll(/\(/g, '\\(').replaceAll(/\)/g, '\\)');
}

/** A one-page PDF whose single Helvetica text object draws `text`. */
export function textPdf(text: string): Buffer {
  const content = `BT /F1 12 Tf 50 750 Td (${escapePdfString(text)}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
  ];
  return pdf(objects);
}

/** An N-page PDF whose pages each draw only a 2x2 DeviceGray image XObject
 *  (no extractable text), shared across all pages. */
export function scannedPdf(pageCount: number): Buffer {
  const imageObj = '<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 4 >>\nstream\n\x80\x40\xc0\x20\nendstream';
  const content = 'q 612 0 0 792 0 0 cm /Im1 Do Q';
  const contentObj = `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`;

  // Object numbers: 1 catalog, 2 pages, 3 image, 4 content, 5..5+N-1 pages.
  const pageRefs: number[] = [];
  for (let i = 0; i < pageCount; i += 1) pageRefs.push(5 + i);

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageRefs.map((n) => `${n} 0 R`).join(' ')}] /Count ${pageCount} >>`,
    imageObj,
    contentObj,
    ...pageRefs.map(
      () =>
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 3 0 R >> >> /Contents 4 0 R >>',
    ),
  ];
  return pdf(objects);
}

/** Bytes that are not a valid PDF at all. */
export function garbageBytes(): Buffer {
  return Buffer.from('this is not a pdf file, just some random text\0\x01\x02', 'latin1');
}
