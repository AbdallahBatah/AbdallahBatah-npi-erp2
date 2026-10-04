// Turns a consented document into the image/document `RedactedBlock`s sent
// to the model (ADR-27, spec/madar/02 §5 item 3). This is the ONLY module
// that may produce a `ConsentedBase64` value — every block it returns
// carries the `consentEventId` of the `VerifiedConsent` it was given,
// which `src/llm/client.ts` then checks before anything is sent (I4).
//
// Limits below are from the official docs (platform.claude.com, fetched
// 2026-10-04) and the installed @anthropic-ai/sdk 0.128.0 types: max 10 MB
// per image (base64-encoded); 32 MB per request; at most 100 images per
// request (the stricter bound for 200k-context models); at most 100 PDF
// pages per request when the context window is under 1M tokens.
import type { DocumentMeta, DocumentRow, DocumentStorage } from '../intake/upload';
import { metaSidecarPath, pagePngPath } from '../intake/upload';
import type { VerifiedConsent } from '../intake/consent';
import { staticPrompt } from '../privacy/pseudonymizer';
import type { ConsentedBase64, RedactedBlock, RedactedMessage, VisionMediaType } from './provider';

export const VISION_MAX_IMAGE_BASE64_BYTES = 10 * 1024 * 1024;
export const VISION_MAX_REQUEST_BYTES = 32 * 1024 * 1024;
export const VISION_MAX_IMAGES_PER_REQUEST = 100;
export const PDF_MAX_PAGES_PER_REQUEST = 100;

export class VisionInputError extends Error {
  readonly kind: 'too_large' | 'too_many' | 'unsupported_media' | 'empty' | 'consent_mismatch';

  constructor(kind: VisionInputError['kind'], message?: string) {
    super(message ?? `VisionInputError: ${kind}`);
    this.name = 'VisionInputError';
    this.kind = kind;
  }
}

/** Upper bound on a base64-encoded string's length for `byteLength` raw
 *  bytes (no padding subtracted — a slight over-estimate, which is the
 *  safe direction for a "must not exceed" check). Computed from the raw
 *  length so an over-limit input can be rejected without actually
 *  base64-encoding it. */
function base64EncodedLength(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4;
}

function toConsentedBase64(bytes: Uint8Array): ConsentedBase64 {
  return Buffer.from(bytes).toString('base64') as ConsentedBase64;
}

export function imageBlock(
  consent: VerifiedConsent,
  image: { mediaType: VisionMediaType; bytes: Uint8Array },
): Extract<RedactedBlock, { type: 'image' }> {
  if (image.bytes.length === 0) throw new VisionInputError('empty');
  if (base64EncodedLength(image.bytes.length) > VISION_MAX_IMAGE_BASE64_BYTES) {
    throw new VisionInputError('too_large');
  }
  return {
    type: 'image',
    mediaType: image.mediaType,
    data: toConsentedBase64(image.bytes),
    consentEventId: consent.consentEventId,
    sizeBytes: image.bytes.length,
  };
}

export function pdfBlock(
  consent: VerifiedConsent,
  pdf: { bytes: Uint8Array; title?: string },
): Extract<RedactedBlock, { type: 'document' }> {
  if (pdf.bytes.length === 0) throw new VisionInputError('empty');
  // A whole PDF is sent as one block, so it is checked against the
  // request-wide bound rather than the per-image bound.
  if (base64EncodedLength(pdf.bytes.length) > VISION_MAX_REQUEST_BYTES) {
    throw new VisionInputError('too_large');
  }
  return {
    type: 'document',
    mediaType: 'application/pdf',
    data: toConsentedBase64(pdf.bytes),
    consentEventId: consent.consentEventId,
    sizeBytes: pdf.bytes.length,
    ...(pdf.title !== undefined ? { title: pdf.title } : {}),
  };
}

function imageMediaTypeOf(mime: string): VisionMediaType | null {
  // Only these two are ever written by src/intake/upload.ts (HEIC is
  // converted to JPEG at upload time) — anything else reaching here would
  // be a stored mime type the intake layer never produces.
  if (mime === 'image/jpeg' || mime === 'image/png') return mime;
  return null;
}

/**
 * Builds the vision blocks for one document, already covered by `consent`.
 * `consent.documentId` must match `row.id` — a mismatch means the caller is
 * trying to use one document's consent to send a different one, which is
 * always a bug, never a legitimate path.
 */
export async function documentVisionBlocks(
  consent: VerifiedConsent,
  storage: DocumentStorage,
  row: DocumentRow,
): Promise<RedactedBlock[]> {
  if (consent.documentId !== row.id) {
    throw new VisionInputError('consent_mismatch');
  }

  if (row.kind === 'image') {
    const bytes = await storage.read(row.storagePath);
    if (!bytes) throw new VisionInputError('empty');
    const mediaType = imageMediaTypeOf(row.mime);
    if (!mediaType) throw new VisionInputError('unsupported_media');
    return [imageBlock(consent, { mediaType, bytes })];
  }

  if (row.kind === 'pdf_scanned') {
    const metaBytes = await storage.read(metaSidecarPath(row.storagePath));
    if (!metaBytes) throw new VisionInputError('empty');
    const meta = JSON.parse(Buffer.from(metaBytes).toString('utf8')) as DocumentMeta;
    if (meta.rasterPages > VISION_MAX_IMAGES_PER_REQUEST) throw new VisionInputError('too_many');

    const pages: Array<{ num: number; bytes: Uint8Array }> = [];
    let totalRawBytes = 0;
    for (let num = 1; num <= meta.rasterPages; num += 1) {
      const pageBytes = await storage.read(pagePngPath(row.storagePath, num));
      if (!pageBytes) throw new VisionInputError('empty');
      totalRawBytes += pageBytes.length;
      pages.push({ num, bytes: pageBytes });
    }
    if (base64EncodedLength(totalRawBytes) > VISION_MAX_REQUEST_BYTES) throw new VisionInputError('too_large');

    const multiPage = pages.length > 1;
    const blocks: RedactedBlock[] = [];
    for (const page of pages) {
      // Developer-authored label, never derived from user/NPI data — a
      // static prompt, not a redaction target.
      if (multiPage) blocks.push({ type: 'text', text: staticPrompt(`صفحة ${page.num}:`) });
      blocks.push(imageBlock(consent, { mediaType: 'image/png', bytes: page.bytes }));
    }
    return blocks;
  }

  // pdf_text: text PDFs never go as images — they go to the model only as
  // redacted text (ADR-27).
  throw new VisionInputError('unsupported_media');
}

/** The audit-safe view of one block: text/tool blocks pass through
 *  unchanged (so a request with no vision blocks produces byte-identical
 *  `outboundRedactedText` to before T-22); an image/document block is
 *  reduced to its shape and consent id — its `data` never appears. */
export function auditView(block: RedactedBlock): unknown {
  if (block.type === 'image' || block.type === 'document') {
    return {
      type: block.type,
      mediaType: block.mediaType,
      sizeBytes: block.sizeBytes,
      consentEventId: block.consentEventId,
    };
  }
  return block;
}

export function auditViewOfMessages(
  messages: RedactedMessage[],
): Array<{ role: RedactedMessage['role']; content: unknown }> {
  return messages.map((message) => ({
    role: message.role,
    content: typeof message.content === 'string' ? message.content : message.content.map(auditView),
  }));
}
