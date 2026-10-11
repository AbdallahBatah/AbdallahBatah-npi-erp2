// Document intake orchestration (spec/madar/02 §5.1-5.2): validates an
// upload, detects its real type from magic bytes, rejects confidential
// content, deduplicates by content hash per organization, extracts or
// rasterizes PDFs, converts HEIC to JPEG, and persists the result to a
// content-addressed path plus a Document row.
//
// This module must never import from src/llm, src/privacy or src/npi — a
// model is never involved in intake (enforced by a source guard test).
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import convertHeic from 'heic-convert';
import { analyzePdf, PdfReadError, type PdfAnalysis, type PdfPagePng, type PdfPageText } from './pdf';
import { checkSensitivity } from './sensitivity';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export type DetectedType =
  | { mime: 'application/pdf'; ext: 'pdf'; family: 'pdf' }
  | { mime: 'image/jpeg'; ext: 'jpg'; family: 'image' }
  | { mime: 'image/png'; ext: 'png'; family: 'image' }
  | { mime: 'image/heic'; ext: 'heic'; family: 'heic' };

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']);

/** Detects the real file type from its magic bytes — never from the
 *  browser's content type or the file name extension. */
export function detectFileType(bytes: Uint8Array): DetectedType | null {
  if (
    bytes.length >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  ) {
    return { mime: 'application/pdf', ext: 'pdf', family: 'pdf' };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mime: 'image/jpeg', ext: 'jpg', family: 'image' };
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return { mime: 'image/png', ext: 'png', family: 'image' };
  }
  if (bytes.length >= 12) {
    const ftyp = Buffer.from(bytes.slice(4, 8)).toString('latin1');
    if (ftyp === 'ftyp') {
      const brand = Buffer.from(bytes.slice(8, 12)).toString('latin1');
      if (HEIC_BRANDS.has(brand)) return { mime: 'image/heic', ext: 'heic', family: 'heic' };
    }
  }
  return null;
}

const FORBIDDEN_NAME_CHARS = /[\u0000-\u001F\u007F<>:"|?*]/g;
const MAX_FILE_NAME_LENGTH = 200;
const EXTENSION_RE = /\.[A-Za-z0-9]{1,10}$/;

/** The last path segment, stripped of control/forbidden characters and
 *  capped at MAX_FILE_NAME_LENGTH while keeping the extension. Display name
 *  only — NEVER used as a filesystem path. */
export function sanitizeFileName(name: string): string {
  const lastSegment = name.split(/[/\\]/).pop() ?? '';
  let cleaned = lastSegment.replace(FORBIDDEN_NAME_CHARS, '');
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  if (cleaned.length === 0) return 'document';

  if (cleaned.length > MAX_FILE_NAME_LENGTH) {
    const match = cleaned.match(EXTENSION_RE);
    const ext = match ? match[0] : '';
    const budget = Math.max(0, MAX_FILE_NAME_LENGTH - ext.length);
    cleaned = cleaned.slice(0, budget) + ext;
  }
  return cleaned;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function docsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.COPILOT_DOCS_DIR ?? path.resolve(process.cwd(), 'data', 'copilot_docs');
}

const SAFE_ORG_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function orgDirName(npiOrgId: string): string {
  return SAFE_ORG_ID.test(npiOrgId) ? npiOrgId : sha256Hex(Buffer.from(npiOrgId, 'utf8'));
}

export interface DocumentStorage {
  write(relPath: string, bytes: Uint8Array): Promise<void>;
  read(relPath: string): Promise<Uint8Array | null>;
}

function assertSafeRelPath(relPath: string): string[] {
  if (path.isAbsolute(relPath)) {
    throw new Error(`DocumentStorage: expected a relative path, got an absolute one: "${relPath}"`);
  }
  const segments = relPath.split(/[\\/]/).filter((s) => s.length > 0);
  if (segments.some((s) => s === '..')) {
    throw new Error(`DocumentStorage: path must not contain "..", got "${relPath}"`);
  }
  return segments;
}

export function createFsStorage(root: string): DocumentStorage {
  return {
    async write(relPath: string, bytes: Uint8Array): Promise<void> {
      const segments = assertSafeRelPath(relPath);
      const fullPath = path.join(root, ...segments);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      // An unguessable temp name (not Math.random): nothing else on the host
      // can predict and pre-create it next to the documents.
      const tmpPath = `${fullPath}.tmp-${process.pid}-${randomUUID()}`;
      try {
        await fs.writeFile(tmpPath, bytes);
        await fs.rename(tmpPath, fullPath);
      } catch (err) {
        // A failed write must not leave a half-written temp file next to the
        // documents (seen live with a detached buffer).
        await fs.rm(tmpPath, { force: true });
        throw err;
      }
    },
    async read(relPath: string): Promise<Uint8Array | null> {
      const segments = assertSafeRelPath(relPath);
      const fullPath = path.join(root, ...segments);
      try {
        return await fs.readFile(fullPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
        throw err;
      }
    },
  };
}

export function textSidecarPath(storagePath: string): string {
  return `${storagePath}.text.json`;
}

export function metaSidecarPath(storagePath: string): string {
  return `${storagePath}.meta.json`;
}

export function pagePngPath(storagePath: string, pageNum: number): string {
  return `${storagePath}.p${pageNum}.png`;
}

export interface DocumentMeta {
  pageCount: number;
  textChars: number | null;
  rasterPages: number;
}

export type DocumentKind = 'pdf_text' | 'pdf_scanned' | 'image';

export interface DocumentRow {
  id: string;
  npiOrgId: string;
  npiUserId: string;
  fileName: string;
  mime: string;
  sizeBytes: number;
  sha256: string;
  storagePath: string;
  kind: DocumentKind;
  sensitivityFlag: boolean;
  consentEventId: string | null;
  extractedTextRedactedRef: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IntakeDb {
  document: {
    findUnique(args: {
      where: { npiOrgId_npiUserId_sha256: { npiOrgId: string; npiUserId: string; sha256: string } };
    }): Promise<DocumentRow | null>;
    findFirst(args: { where: { id: string; npiOrgId: string; npiUserId: string } }): Promise<DocumentRow | null>;
    create(args: {
      data: {
        npiOrgId: string;
        npiUserId: string;
        fileName: string;
        mime: string;
        sizeBytes: number;
        sha256: string;
        storagePath: string;
        kind: DocumentKind;
        sensitivityFlag: boolean;
      };
    }): Promise<DocumentRow>;
  };
}

export interface UploadDeps {
  db: IntakeDb;
  storage: DocumentStorage;
  analyzePdf?: typeof analyzePdf;
  convertHeic?: (bytes: Uint8Array) => Promise<Uint8Array>;
}

export interface UploadCaller {
  npiOrgId: string;
  npiUserId: string;
}

export interface UploadInput {
  fileName: string;
  bytes: Uint8Array;
}

export interface DocumentSummary {
  id: string;
  fileName: string;
  mime: string;
  sizeBytes: number;
  kind: DocumentKind;
  pageCount: number;
  textChars: number | null;
  createdAt: string;
}

export type UploadRefusal =
  | 'empty'
  | 'too_large'
  | 'unsupported_type'
  | 'confidential'
  | 'pdf_invalid'
  | 'pdf_encrypted'
  | 'heic_failed';

export type UploadOutcome =
  | { status: 'created'; document: DocumentSummary }
  | { status: 'existing'; document: DocumentSummary }
  | { status: 'refused'; reason: UploadRefusal; detail?: string };

async function defaultConvertHeic(bytes: Uint8Array): Promise<Uint8Array> {
  return convertHeic({ buffer: bytes, format: 'JPEG', quality: 0.9 });
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';
}

function refuse(reason: UploadRefusal, detail?: string | null): UploadOutcome {
  return detail ? { status: 'refused', reason, detail } : { status: 'refused', reason };
}

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

export async function summarizeDocument(storage: DocumentStorage, row: DocumentRow): Promise<DocumentSummary> {
  const metaBytes = await storage.read(metaSidecarPath(row.storagePath));
  let meta: DocumentMeta | null = null;
  if (metaBytes) {
    try {
      meta = JSON.parse(Buffer.from(metaBytes).toString('utf8')) as DocumentMeta;
    } catch {
      meta = null;
    }
  }
  return {
    id: row.id,
    fileName: row.fileName,
    mime: row.mime,
    sizeBytes: row.sizeBytes,
    kind: row.kind,
    pageCount: meta ? meta.pageCount : row.kind === 'image' ? 1 : 0,
    textChars: meta ? meta.textChars : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function uploadDocument(
  deps: UploadDeps,
  caller: UploadCaller,
  input: UploadInput,
): Promise<UploadOutcome> {
  const bytes = input.bytes;
  if (bytes.length === 0) return refuse('empty');
  if (bytes.length > MAX_UPLOAD_BYTES) return refuse('too_large');

  const detected = detectFileType(bytes);
  if (!detected) return refuse('unsupported_type');

  const fileName = sanitizeFileName(input.fileName);
  const nameVerdict = checkSensitivity({ fileName });
  if (nameVerdict.confidential) return refuse('confidential', nameVerdict.matched);

  const sha256 = sha256Hex(bytes);
  // D-T31-11: deduplicated per user within the organization. Every later read
  // of a document (the chat turn, the consent, the document page) is by owner,
  // so a colleague's identical upload must become a row of their own — it
  // shares the content-addressed storage path below, so the bytes are kept once.
  const existing = await deps.db.document.findUnique({
    where: { npiOrgId_npiUserId_sha256: { npiOrgId: caller.npiOrgId, npiUserId: caller.npiUserId, sha256 } },
  });
  if (existing) {
    return { status: 'existing', document: await summarizeDocument(deps.storage, existing) };
  }

  const orgDir = orgDirName(caller.npiOrgId);
  const analyzePdfFn = deps.analyzePdf ?? analyzePdf;
  const convertHeicFn = deps.convertHeic ?? defaultConvertHeic;

  let bytesToStore: Uint8Array = bytes;
  let storageExt: string;
  let kind: DocumentKind;
  let mime: string;
  let meta: DocumentMeta;
  let textSidecar: { pages: PdfPageText[] } | null = null;
  let pagePngs: PdfPagePng[] = [];

  if (detected.family === 'pdf') {
    let analysis: PdfAnalysis;
    try {
      analysis = await analyzePdfFn(bytes);
    } catch (err) {
      if (err instanceof PdfReadError) {
        return refuse(err.kind === 'encrypted' ? 'pdf_encrypted' : 'pdf_invalid', err.message);
      }
      throw err;
    }

    if (analysis.kind === 'pdf_text') {
      const textVerdict = checkSensitivity({ fileName, text: analysis.text });
      if (textVerdict.confidential) return refuse('confidential', textVerdict.matched);
      kind = 'pdf_text';
      meta = { pageCount: analysis.pageCount, textChars: analysis.textChars, rasterPages: 0 };
      textSidecar = { pages: analysis.pages };
    } else {
      kind = 'pdf_scanned';
      meta = { pageCount: analysis.pageCount, textChars: null, rasterPages: analysis.pages.length };
      pagePngs = analysis.pages;
    }
    storageExt = 'pdf';
    mime = detected.mime;
  } else if (detected.family === 'image') {
    kind = 'image';
    mime = detected.mime;
    storageExt = detected.ext;
    meta = { pageCount: 1, textChars: null, rasterPages: 0 };
  } else {
    try {
      bytesToStore = await convertHeicFn(bytes);
    } catch {
      return refuse('heic_failed');
    }
    kind = 'image';
    mime = 'image/jpeg';
    storageExt = 'jpg';
    meta = { pageCount: 1, textChars: null, rasterPages: 0 };
  }

  const storagePath = `${orgDir}/${sha256}.${storageExt}`;

  await deps.storage.write(storagePath, bytesToStore);
  if (textSidecar) await deps.storage.write(textSidecarPath(storagePath), jsonBytes(textSidecar));
  for (const page of pagePngs) await deps.storage.write(pagePngPath(storagePath, page.num), page.png);
  await deps.storage.write(metaSidecarPath(storagePath), jsonBytes(meta));

  let created: DocumentRow;
  try {
    created = await deps.db.document.create({
      data: {
        npiOrgId: caller.npiOrgId,
        npiUserId: caller.npiUserId,
        fileName,
        mime,
        sizeBytes: bytes.length,
        sha256,
        storagePath,
        kind,
        sensitivityFlag: false,
      },
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      const race = await deps.db.document.findUnique({
        where: { npiOrgId_npiUserId_sha256: { npiOrgId: caller.npiOrgId, npiUserId: caller.npiUserId, sha256 } },
      });
      if (race) return { status: 'existing', document: await summarizeDocument(deps.storage, race) };
    }
    throw err;
  }

  return { status: 'created', document: await summarizeDocument(deps.storage, created) };
}
