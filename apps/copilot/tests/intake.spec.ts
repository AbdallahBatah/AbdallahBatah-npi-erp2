/** @jest-environment <rootDir>/tests/helpers/pdfjs-env.js */
// T-21 acceptance: document intake (spec/madar/02 §5.1-5.2) — confidentiality
// detection, magic-byte type detection, file-name sanitization, content-
// addressed filesystem storage, real PDF analysis (text vs. scanned), and
// the uploadDocument orchestration, plus the POST/GET route.
//
// The route-level tests below re-require '@/app/api/documents/route' and
// 'next/server' per test (after re-configuring the '@/auth/session' and
// '@/db' mocks), rather than importing them statically — a dynamic
// `require()` is the simplest way to do that under ts-jest's CommonJS
// output.
/* eslint-disable @typescript-eslint/no-require-imports */
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PrismaClient } from '../src/generated/prisma';
import {
  checkSensitivity,
  isConfidentialText,
  SENSITIVITY_TEXT_WINDOW,
} from '../src/intake/sensitivity';
import {
  analyzePdf,
  PDF_RASTER_MAX_PAGES,
  PDF_RASTER_WIDTH_PX,
  PDF_TEXT_MIN_CHARS,
  PdfReadError,
} from '../src/intake/pdf';
import {
  createFsStorage,
  detectFileType,
  docsRoot,
  MAX_UPLOAD_BYTES,
  sha256Hex,
  orgDirName,
  sanitizeFileName,
  summarizeDocument,
  uploadDocument,
  type DocumentRow,
  type DocumentStorage,
  type IntakeDb,
} from '../src/intake/upload';
import type { LlmAuditData } from '../src/audit/log';
import { garbageBytes, scannedPdf, textPdf } from './helpers/pdf-fixtures';

// ─── sensitivity ────────────────────────────────────────────────────────────

describe('checkSensitivity / isConfidentialText', () => {
  const positiveFileNames = [
    'عقد-سري.pdf',
    'عقد سرّي.pdf',
    'العقد السري.pdf',
    'وثيقة_سرية_2026.pdf',
    'CONFIDENTIAL - Contract.pdf',
  ];
  const negativeFileNames = [
    'عرض سعر سريع.pdf',
    'سرير-المستشفى.pdf',
    'Confidentiality agreement.pdf',
    'contract-01.pdf',
  ];
  const positiveTexts = [
    'هذه الوثيقة سرّية ولا تُنشر',
    'Confidential: internal use only',
    'معلومات سرية للغاية',
  ];
  const negativeTexts = ['سريان العقد من 1 يناير', 'التسليم السريع', ''];

  it.each(positiveFileNames)('flags file name %s as confidential', (name) => {
    expect(checkSensitivity({ fileName: name })).toMatchObject({ confidential: true, reason: 'filename' });
  });

  it.each(negativeFileNames)('does not flag file name %s', (name) => {
    expect(checkSensitivity({ fileName: name }).confidential).toBe(false);
  });

  it.each(positiveTexts)('flags text %s as confidential', (text) => {
    expect(checkSensitivity({ fileName: 'doc.pdf', text })).toMatchObject({ confidential: true, reason: 'text' });
  });

  it.each(negativeTexts)('does not flag text %s', (text) => {
    expect(checkSensitivity({ fileName: 'doc.pdf', text }).confidential).toBe(false);
  });

  it('ignores a marker placed after the first SENSITIVITY_TEXT_WINDOW characters', () => {
    const padding = 'x'.repeat(SENSITIVITY_TEXT_WINDOW);
    const text = `${padding} سري`;
    expect(isConfidentialText(text.slice(0, SENSITIVITY_TEXT_WINDOW))).toBeNull();
    expect(checkSensitivity({ fileName: 'doc.pdf', text }).confidential).toBe(false);
  });

  it('sees a marker placed just before the window closes', () => {
    const padding = 'x '.repeat(995); // 1990 chars
    const text = `${padding}سري`;
    expect(checkSensitivity({ fileName: 'doc.pdf', text }).confidential).toBe(true);
  });

  it('is false for empty text and an unmarked file name', () => {
    expect(checkSensitivity({ fileName: 'contract-01.pdf', text: '' })).toEqual({
      confidential: false,
      reason: null,
      matched: null,
    });
  });
});

// ─── detectFileType ─────────────────────────────────────────────────────────

describe('detectFileType', () => {
  it('detects a PDF from its %PDF- header', () => {
    expect(detectFileType(Buffer.from('%PDF-1.4 rest', 'latin1'))).toEqual({
      mime: 'application/pdf',
      ext: 'pdf',
      family: 'pdf',
    });
  });

  it('detects a JPEG from its FF D8 FF header', () => {
    expect(detectFileType(Buffer.from([0xff, 0xd8, 0xff, 0, 0, 0]))).toEqual({
      mime: 'image/jpeg',
      ext: 'jpg',
      family: 'image',
    });
  });

  it('detects a PNG from its 8-byte signature, ignoring a .pdf-named extension', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    expect(detectFileType(png)).toEqual({ mime: 'image/png', ext: 'png', family: 'image' });
  });

  it.each(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'])(
    'detects HEIC brand %s',
    (brand) => {
      const bytes = Buffer.concat([
        Buffer.from([0, 0, 0, 0x18]),
        Buffer.from('ftyp', 'latin1'),
        Buffer.from(brand, 'latin1'),
        Buffer.alloc(4),
      ]);
      expect(detectFileType(bytes)).toEqual({ mime: 'image/heic', ext: 'heic', family: 'heic' });
    },
  );

  it('returns null for random bytes', () => {
    expect(detectFileType(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))).toBeNull();
  });

  it('returns null for fewer than 4 bytes', () => {
    expect(detectFileType(Buffer.from([0xff, 0xd8]))).toBeNull();
  });
});

// ─── sanitizeFileName ───────────────────────────────────────────────────────

describe('sanitizeFileName', () => {
  it('keeps only the last path segment', () => {
    expect(sanitizeFileName('../../etc/passwd.pdf')).toBe('passwd.pdf');
    expect(sanitizeFileName('C:\\Users\\x\\عقد.pdf')).toBe('عقد.pdf');
  });

  it('strips control characters and forbidden characters', () => {
    expect(sanitizeFileName('a\u0000b\u0007<c>:"d"|?*.pdf')).toBe('abcd.pdf');
  });

  it('caps a 300-character name at 200 characters, keeping the extension', () => {
    const long = `${'a'.repeat(300)}.pdf`;
    const result = sanitizeFileName(long);
    expect(result.length).toBe(200);
    expect(result.endsWith('.pdf')).toBe(true);
  });

  it('falls back to "document" for an empty or whitespace-only name', () => {
    expect(sanitizeFileName('')).toBe('document');
    expect(sanitizeFileName('   ')).toBe('document');
  });
});

// ─── orgDirName / docsRoot ──────────────────────────────────────────────────

describe('orgDirName', () => {
  it('leaves a safe org id unchanged', () => {
    expect(orgDirName('org_npi_root')).toBe('org_npi_root');
  });

  it('hashes an unsafe org id to 64 hex characters', () => {
    const result = orgDirName('org madar/x');
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('docsRoot', () => {
  it('defaults to <cwd>/data/copilot_docs', () => {
    expect(docsRoot({} as NodeJS.ProcessEnv)).toBe(path.resolve(process.cwd(), 'data', 'copilot_docs'));
  });

  it('honors COPILOT_DOCS_DIR when set', () => {
    expect(docsRoot({ COPILOT_DOCS_DIR: '/custom/dir' } as unknown as NodeJS.ProcessEnv)).toBe('/custom/dir');
  });
});

// ─── createFsStorage ────────────────────────────────────────────────────────

describe('createFsStorage', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'copilot-intake-'));
  });

  afterEach(() => {
    fsSync.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes and reads back bytes, creating parent directories', async () => {
    const storage = createFsStorage(tmpDir);
    const bytes = Buffer.from([1, 2, 3, 4]);
    await storage.write('a/b/c.bin', bytes);
    const read = await storage.read('a/b/c.bin');
    expect(Buffer.from(read!)).toEqual(bytes);
  });

  it('returns null for a missing file', async () => {
    const storage = createFsStorage(tmpDir);
    expect(await storage.read('nope.bin')).toBeNull();
  });

  it('refuses an absolute path', async () => {
    const storage = createFsStorage(tmpDir);
    await expect(storage.write(path.resolve(tmpDir, 'x.bin'), Buffer.from([1]))).rejects.toThrow();
  });

  it('refuses a path with a ".." segment', async () => {
    const storage = createFsStorage(tmpDir);
    await expect(storage.write('../escape.bin', Buffer.from([1]))).rejects.toThrow();
  });

  it('writes atomically, leaving no .tmp file behind', async () => {
    const storage = createFsStorage(tmpDir);
    await storage.write('final.bin', Buffer.from([9]));
    const entries = fsSync.readdirSync(tmpDir);
    expect(entries).toEqual(['final.bin']);
  });
});

// ─── analyzePdf (real pdf-parse) ────────────────────────────────────────────

describe('createFsStorage failure path', () => {
  it('leaves no temporary file behind when the write itself fails', async () => {
    const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'copilot-intake-tmpfail-'));
    try {
      const storage = createFsStorage(dir);
      const bytes = new Uint8Array(16);
      // Detach the buffer the way pdfjs does when it takes ownership of one.
      structuredClone(bytes, { transfer: [bytes.buffer] });
      await expect(storage.write('org/doc.pdf', bytes)).rejects.toThrow();
      expect(fsSync.existsSync(path.join(dir, 'org', 'doc.pdf'))).toBe(false);
      const leftovers = fsSync.existsSync(path.join(dir, 'org')) ? fsSync.readdirSync(path.join(dir, 'org')) : [];
      expect(leftovers).toEqual([]);
    } finally {
      fsSync.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('analyzePdf', () => {
  it('leaves the bytes it was given intact (pdfjs would otherwise detach the buffer)', async () => {
    const bytes = textPdf('This is a plain contract document without any sensitive markers at all.');
    const length = bytes.byteLength;
    const checksum = sha256Hex(bytes);
    await analyzePdf(bytes);
    expect(bytes.byteLength).toBe(length);
    expect(sha256Hex(bytes)).toBe(checksum);
    // A detached buffer cannot be written: this is what failed live.
    const storage = createFsStorage(fsSync.mkdtempSync(path.join(os.tmpdir(), 'copilot-intake-detach-')));
    await expect(storage.write('x/y.pdf', bytes)).resolves.toBeUndefined();
  }, 30_000);

  it('extracts text from a text PDF (>= PDF_TEXT_MIN_CHARS)', async () => {
    const text = 'This is a plain contract document without any sensitive markers at all.';
    expect(text.length).toBeGreaterThanOrEqual(PDF_TEXT_MIN_CHARS);
    const result = await analyzePdf(textPdf(text));
    expect(result.kind).toBe('pdf_text');
    if (result.kind === 'pdf_text') {
      expect(result.pageCount).toBe(1);
      expect(result.text).toContain('This is a plain contract document');
      expect(result.textChars).toBeGreaterThanOrEqual(PDF_TEXT_MIN_CHARS);
    }
  }, 30_000);

  it('rasterizes a 1-page scanned PDF to one PNG at the configured width', async () => {
    const result = await analyzePdf(scannedPdf(1));
    expect(result.kind).toBe('pdf_scanned');
    if (result.kind === 'pdf_scanned') {
      expect(result.pageCount).toBe(1);
      expect(result.pages).toHaveLength(1);
      const png = Buffer.from(result.pages[0].png);
      expect(png.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      expect(result.pages[0].width).toBe(PDF_RASTER_WIDTH_PX);
    }
  }, 30_000);

  it('rasterizes only the first PDF_RASTER_MAX_PAGES of a 7-page scanned PDF', async () => {
    const result = await analyzePdf(scannedPdf(7));
    expect(result.kind).toBe('pdf_scanned');
    if (result.kind === 'pdf_scanned') {
      expect(result.pageCount).toBe(7);
      expect(result.pages).toHaveLength(PDF_RASTER_MAX_PAGES);
      expect(result.pages.map((p) => p.num)).toEqual([1, 2, 3, 4, 5]);
    }
  }, 60_000);

  it('treats a text PDF below PDF_TEXT_MIN_CHARS as scanned', async () => {
    const result = await analyzePdf(textPdf('Hi'));
    expect(result.kind).toBe('pdf_scanned');
  }, 30_000);

  it('throws a PdfReadError of kind "invalid" for garbage bytes', async () => {
    await expect(analyzePdf(garbageBytes())).rejects.toMatchObject({ kind: 'invalid' });
    await expect(analyzePdf(garbageBytes())).rejects.toBeInstanceOf(PdfReadError);
  });
});

// ─── uploadDocument (fake db + fake storage) ───────────────────────────────

function createFakeStorage() {
  const files = new Map<string, Uint8Array>();
  const writes: string[] = [];
  const storage: DocumentStorage = {
    async write(relPath, bytes) {
      writes.push(relPath);
      files.set(relPath, bytes);
    },
    async read(relPath) {
      return files.get(relPath) ?? null;
    },
  };
  return { storage, files, writes };
}

function createFakeDb() {
  const rows: DocumentRow[] = [];
  const auditRows: LlmAuditData[] = [];
  let seq = 0;
  let createCalls = 0;
  const intakeDb: IntakeDb = {
    document: {
      async findUnique({ where }) {
        const key = where.npiOrgId_sha256;
        return rows.find((r) => r.npiOrgId === key.npiOrgId && r.sha256 === key.sha256) ?? null;
      },
      async findFirst({ where }) {
        return (
          rows.find((r) => r.id === where.id && r.npiOrgId === where.npiOrgId && r.npiUserId === where.npiUserId) ??
          null
        );
      },
      async create({ data }) {
        createCalls += 1;
        const exists = rows.find((r) => r.npiOrgId === data.npiOrgId && r.sha256 === data.sha256);
        if (exists) throw { code: 'P2002' };
        const now = new Date();
        const row: DocumentRow = {
          id: `doc_${++seq}`,
          npiOrgId: data.npiOrgId,
          npiUserId: data.npiUserId,
          fileName: data.fileName,
          mime: data.mime,
          sizeBytes: data.sizeBytes,
          sha256: data.sha256,
          storagePath: data.storagePath,
          kind: data.kind,
          sensitivityFlag: data.sensitivityFlag,
          consentEventId: null,
          extractedTextRedactedRef: null,
          createdAt: now,
          updatedAt: now,
        };
        rows.push(row);
        return row;
      },
    },
  };
  // Not part of `IntakeDb` — this extra property lets the same fake object,
  // once returned by the mocked `getDb()`, also satisfy `AuditDb` for the
  // route's `writeAuditEvent` call on a confidential refusal (T-22, AT-06).
  const db = { ...intakeDb, llmAudit: { create: async (args: { data: LlmAuditData }) => { auditRows.push(args.data); return args.data; } } };
  return { db, rows, auditRows, getCreateCalls: () => createCalls };
}

const CALLER = { npiOrgId: 'org1', npiUserId: 'user1' };

function jpegBytes(suffix: number[] = [1, 2, 3, 4]): Uint8Array {
  return Buffer.from([0xff, 0xd8, 0xff, ...suffix]);
}

function pngBytes(suffix: number[] = [1, 2, 3, 4]): Uint8Array {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...suffix]);
}

function heicBytes(suffix: number[] = [9, 9, 9, 9]): Uint8Array {
  return Buffer.concat([
    Buffer.from([0, 0, 0, 0x18]),
    Buffer.from('ftyp', 'latin1'),
    Buffer.from('heic', 'latin1'),
    Buffer.from(suffix),
  ]);
}

describe('uploadDocument', () => {
  it('stores a created pdf_text document with its text sidecar and meta', async () => {
    const { db } = createFakeDb();
    const { storage, files } = createFakeStorage();
    const text = 'This is a plain contract document without any sensitive markers at all.';

    const outcome = await uploadDocument({ db, storage }, CALLER, { fileName: 'contract.pdf', bytes: textPdf(text) });

    expect(outcome.status).toBe('created');
    if (outcome.status !== 'created') return;
    expect(outcome.document.kind).toBe('pdf_text');
    expect(outcome.document.pageCount).toBe(1);
    expect(outcome.document.textChars).toBeGreaterThanOrEqual(PDF_TEXT_MIN_CHARS);

    const storagePath = [...files.keys()].find((k) => k.endsWith('.pdf'))!;
    expect(files.has(`${storagePath}.text.json`)).toBe(true);
    expect(files.has(`${storagePath}.meta.json`)).toBe(true);
  }, 30_000);

  it('stores a created pdf_scanned document with at most PDF_RASTER_MAX_PAGES PNGs', async () => {
    const { db } = createFakeDb();
    const { storage, files } = createFakeStorage();

    const outcome = await uploadDocument({ db, storage }, CALLER, { fileName: 'scan.pdf', bytes: scannedPdf(7) });

    expect(outcome.status).toBe('created');
    if (outcome.status !== 'created') return;
    expect(outcome.document.kind).toBe('pdf_scanned');
    expect(outcome.document.pageCount).toBe(7);

    const pngKeys = [...files.keys()].filter((k) => k.endsWith('.png'));
    expect(pngKeys).toHaveLength(PDF_RASTER_MAX_PAGES);
  }, 60_000);

  it('stores a created image document (jpg)', async () => {
    const { db } = createFakeDb();
    const { storage, files } = createFakeStorage();

    const outcome = await uploadDocument({ db, storage }, CALLER, { fileName: 'photo.jpg', bytes: jpegBytes() });

    expect(outcome.status).toBe('created');
    if (outcome.status !== 'created') return;
    expect(outcome.document.kind).toBe('image');
    expect(outcome.document.mime).toBe('image/jpeg');
    expect([...files.keys()].some((k) => k.endsWith('.jpg'))).toBe(true);
  });

  it('stores a created image document (png)', async () => {
    const { db } = createFakeDb();
    const { storage, files } = createFakeStorage();

    const outcome = await uploadDocument({ db, storage }, CALLER, { fileName: 'photo.png', bytes: pngBytes() });

    expect(outcome.status).toBe('created');
    if (outcome.status !== 'created') return;
    expect(outcome.document.kind).toBe('image');
    expect(outcome.document.mime).toBe('image/png');
    expect([...files.keys()].some((k) => k.endsWith('.png'))).toBe(true);
  });

  it('converts a HEIC upload to JPEG via the injected convertHeic', async () => {
    const { db } = createFakeDb();
    const { storage, files } = createFakeStorage();
    const original = heicBytes();
    const fakeJpeg = new Uint8Array([0xff, 0xd8, 0xff, 7, 7, 7]);
    const convertHeic = jest.fn(async () => fakeJpeg);

    const outcome = await uploadDocument({ db, storage, convertHeic }, CALLER, {
      fileName: 'photo.heic',
      bytes: original,
    });

    expect(convertHeic).toHaveBeenCalledWith(original);
    expect(outcome.status).toBe('created');
    if (outcome.status !== 'created') return;
    expect(outcome.document.mime).toBe('image/jpeg');
    expect(outcome.document.sizeBytes).toBe(original.length);
    const storedPath = [...files.keys()].find((k) => k.endsWith('.jpg'))!;
    expect(Buffer.from(files.get(storedPath)!)).toEqual(Buffer.from(fakeJpeg));
  });

  it('refuses heic_failed when convertHeic throws', async () => {
    const { db } = createFakeDb();
    const { storage, files } = createFakeStorage();
    const convertHeic = jest.fn(async () => {
      throw new Error('boom');
    });

    const outcome = await uploadDocument({ db, storage, convertHeic }, CALLER, {
      fileName: 'photo.heic',
      bytes: heicBytes(),
    });

    expect(outcome).toEqual({ status: 'refused', reason: 'heic_failed' });
    expect(files.size).toBe(0);
  });

  it('refuses empty uploads', async () => {
    const { db } = createFakeDb();
    const { storage } = createFakeStorage();
    const outcome = await uploadDocument({ db, storage }, CALLER, { fileName: 'x.pdf', bytes: new Uint8Array(0) });
    expect(outcome).toEqual({ status: 'refused', reason: 'empty' });
  });

  it('refuses uploads over MAX_UPLOAD_BYTES', async () => {
    const { db } = createFakeDb();
    const { storage } = createFakeStorage();
    const bytes = Buffer.alloc(MAX_UPLOAD_BYTES + 1);
    const outcome = await uploadDocument({ db, storage }, CALLER, { fileName: 'x.pdf', bytes });
    expect(outcome).toEqual({ status: 'refused', reason: 'too_large' });
  });

  it('refuses an unrecognized file type', async () => {
    const { db } = createFakeDb();
    const { storage } = createFakeStorage();
    const bytes = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const outcome = await uploadDocument({ db, storage }, CALLER, { fileName: 'x.bin', bytes });
    expect(outcome).toEqual({ status: 'refused', reason: 'unsupported_type' });
  });

  it('refuses a confidential file name before touching storage or the db', async () => {
    const { db, getCreateCalls } = createFakeDb();
    const { storage, files } = createFakeStorage();

    const outcome = await uploadDocument({ db, storage }, CALLER, {
      fileName: 'عقد-سري.pdf',
      bytes: jpegBytes(),
    });

    expect(outcome.status).toBe('refused');
    if (outcome.status === 'refused') expect(outcome.reason).toBe('confidential');
    expect(files.size).toBe(0);
    expect(getCreateCalls()).toBe(0);
  });

  it('refuses confidential PDF text before storing anything', async () => {
    const { db, getCreateCalls } = createFakeDb();
    const { storage, files } = createFakeStorage();
    const text = 'This document is confidential and must not be shared with external parties.';

    const outcome = await uploadDocument({ db, storage }, CALLER, { fileName: 'doc.pdf', bytes: textPdf(text) });

    expect(outcome.status).toBe('refused');
    if (outcome.status === 'refused') expect(outcome.reason).toBe('confidential');
    expect(files.size).toBe(0);
    expect(getCreateCalls()).toBe(0);
  }, 30_000);

  it('refuses pdf_encrypted and pdf_invalid through an injected analyzePdf', async () => {
    const { db } = createFakeDb();
    const { storage } = createFakeStorage();

    const encrypted = await uploadDocument(
      { db, storage, analyzePdf: async () => { throw new PdfReadError('encrypted'); } },
      CALLER,
      { fileName: 'doc.pdf', bytes: Buffer.from('%PDF-1.4', 'latin1') },
    );
    expect(encrypted).toEqual({ status: 'refused', reason: 'pdf_encrypted', detail: 'encrypted' });

    const invalid = await uploadDocument(
      { db, storage, analyzePdf: async () => { throw new PdfReadError('invalid'); } },
      CALLER,
      { fileName: 'doc2.pdf', bytes: Buffer.from('%PDF-1.4 other', 'latin1') },
    );
    expect(invalid).toEqual({ status: 'refused', reason: 'pdf_invalid', detail: 'invalid' });
  });

  it('returns existing on a second upload of identical bytes by a different user of the same org', async () => {
    const { db } = createFakeDb();
    const { storage, writes } = createFakeStorage();
    const bytes = jpegBytes();

    const first = await uploadDocument({ db, storage }, CALLER, { fileName: 'a.jpg', bytes });
    expect(first.status).toBe('created');
    const writesAfterFirst = writes.length;

    const second = await uploadDocument({ db, storage }, { npiOrgId: 'org1', npiUserId: 'user2' }, {
      fileName: 'b.jpg',
      bytes,
    });

    expect(second.status).toBe('existing');
    expect(writes.length).toBe(writesAfterFirst); // no second write
  });

  it('re-reads and returns existing when create() races with a concurrent insert (P2002)', async () => {
    const { db, rows } = createFakeDb();
    const { storage } = createFakeStorage();
    const bytes = jpegBytes();

    const originalCreate = db.document.create.bind(db.document);
    let calls = 0;
    db.document.create = (async (args: Parameters<typeof originalCreate>[0]) => {
      calls += 1;
      if (calls === 1) {
        const now = new Date();
        rows.push({
          id: 'doc-race',
          ...args.data,
          consentEventId: null,
          extractedTextRedactedRef: null,
          createdAt: now,
          updatedAt: now,
        });
        throw { code: 'P2002' };
      }
      return originalCreate(args);
    }) as typeof originalCreate;

    const outcome = await uploadDocument({ db, storage }, CALLER, { fileName: 'raced.jpg', bytes });

    expect(outcome.status).toBe('existing');
    if (outcome.status === 'existing') expect(outcome.document.id).toBe('doc-race');
    expect(calls).toBe(1);
  });
});

// ─── summarizeDocument fallback (no meta sidecar) ──────────────────────────

describe('summarizeDocument', () => {
  it('falls back to pageCount 1 for an image with no meta sidecar, 0 otherwise', async () => {
    const { storage } = createFakeStorage();
    const now = new Date();
    const imageRow: DocumentRow = {
      id: 'd1',
      npiOrgId: 'org1',
      npiUserId: 'user1',
      fileName: 'x.jpg',
      mime: 'image/jpeg',
      sizeBytes: 10,
      sha256: 'abc',
      storagePath: 'org1/abc.jpg',
      kind: 'image',
      sensitivityFlag: false,
      consentEventId: null,
      extractedTextRedactedRef: null,
      createdAt: now,
      updatedAt: now,
    };
    const pdfRow: DocumentRow = { ...imageRow, id: 'd2', kind: 'pdf_text', storagePath: 'org1/abc.pdf' };

    const imageSummary = await summarizeDocument(storage, imageRow);
    const pdfSummary = await summarizeDocument(storage, pdfRow);

    expect(imageSummary.pageCount).toBe(1);
    expect(imageSummary.textChars).toBeNull();
    expect(pdfSummary.pageCount).toBe(0);
    expect(pdfSummary.textChars).toBeNull();
  });
});

// ─── type-level check: the real PrismaClient satisfies IntakeDb ───────────

describe('IntakeDb structural type', () => {
  it('is satisfied by the real PrismaClient without a cast (type-only check)', () => {
    // This function is never called; its only purpose is for the TypeScript
    // compiler to check that PrismaClient is assignable to IntakeDb. No
    // database connection is opened — getDb() is never called.
    function typeCheckOnly() {
      const _db: IntakeDb = {} as PrismaClient;
      void _db;
    }
    expect(typeof typeCheckOnly).toBe('function');
  });
});

// ─── source guard ───────────────────────────────────────────────────────────

describe('intake source guard', () => {
  it('src/intake/{upload,pdf,sensitivity,consent}.ts never import llm, privacy or npi modules', () => {
    const files = ['upload.ts', 'pdf.ts', 'sensitivity.ts', 'consent.ts'].map((name) =>
      fsSync.readFileSync(path.join(__dirname, '..', 'src', 'intake', name), 'utf8'),
    );
    for (const content of files) {
      expect(content).not.toMatch(/from ['"][^'"]*\/llm/);
      expect(content).not.toMatch(/from ['"]@\/llm/);
      expect(content).not.toMatch(/\/privacy\//);
      expect(content).not.toMatch(/\/npi\//);
    }
  });
});

// ─── route: POST / GET /copilot/api/documents ──────────────────────────────

jest.mock('../src/auth/session', () => ({
  getServerSession: jest.fn(),
}));
jest.mock('../src/db', () => ({
  getDb: jest.fn(),
}));

describe('POST /copilot/api/documents and GET /copilot/api/documents', () => {
  let tmpDocsDir: string;
  let previousDocsDir: string | undefined;

  beforeAll(() => {
    tmpDocsDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'copilot-intake-route-'));
    previousDocsDir = process.env.COPILOT_DOCS_DIR;
    process.env.COPILOT_DOCS_DIR = tmpDocsDir;
  });

  afterAll(() => {
    fsSync.rmSync(tmpDocsDir, { recursive: true, force: true });
    if (previousDocsDir === undefined) delete process.env.COPILOT_DOCS_DIR;
    else process.env.COPILOT_DOCS_DIR = previousDocsDir;
  });

  function mockSession(user: { npiOrgId: string; npiUserId: string } | null) {
    const sessionModule = require('../src/auth/session');
    sessionModule.getServerSession.mockImplementation(async () => {
      if (!user) return null;
      return { npiToken: 'tok', user: { ...user, roleKey: 'admin', permissions: [] } };
    });
  }

  function mockDb() {
    const { db, rows, auditRows } = createFakeDb();
    const dbModule = require('../src/db');
    dbModule.getDb.mockReturnValue(db);
    return { db, rows, auditRows };
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('POST returns 201 and the document summary for a new upload, writing no audit row', async () => {
    mockSession({ npiOrgId: 'org1', npiUserId: 'user1' });
    const { auditRows } = mockDb();
    const { POST } = require('../src/app/api/documents/route');
    const { NextRequest } = require('next/server');

    const fd = new FormData();
    fd.append('file', new File([Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3])], 'photo.jpg'));
    const req = new NextRequest('http://localhost/copilot/api/documents', { method: 'POST', body: fd });

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.document.kind).toBe('image');
    expect(auditRows).toHaveLength(0);
  });

  it('POST returns 422 refused_confidential for a confidential file name and writes exactly one refused_confidential audit row', async () => {
    mockSession({ npiOrgId: 'org1', npiUserId: 'user1' });
    const { auditRows } = mockDb();
    const { POST } = require('../src/app/api/documents/route');
    const { NextRequest } = require('next/server');

    const fd = new FormData();
    fd.append('file', new File([Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3])], 'عقد-سري.jpg'));
    const req = new NextRequest('http://localhost/copilot/api/documents', { method: 'POST', body: fd });

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.error).toBe('refused_confidential');
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].event).toBe('refused_confidential');
  });

  it('POST returns 401 when there is no session', async () => {
    mockSession(null);
    mockDb();
    const { POST } = require('../src/app/api/documents/route');
    const { NextRequest } = require('next/server');

    const fd = new FormData();
    fd.append('file', new File([Buffer.from([0xff, 0xd8, 0xff])], 'a.jpg'));
    const req = new NextRequest('http://localhost/copilot/api/documents', { method: 'POST', body: fd });

    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it('POST returns 413 before parsing a body whose declared length cannot fit the cap', async () => {
    mockSession({ npiOrgId: 'org1', npiUserId: 'user1' });
    const { rows } = mockDb();
    const { POST } = require('../src/app/api/documents/route');
    const { NextRequest } = require('next/server');

    const req = new NextRequest('http://localhost/copilot/api/documents', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=x', 'content-length': String(MAX_UPLOAD_BYTES + 1024 * 1024) },
      body: 'not read',
    });

    const res = await POST(req);
    const body = await res.json();
    expect(res.status).toBe(413);
    expect(body.error).toBe('too_large');
    expect(rows).toHaveLength(0);
  });

  it('POST returns 415 for a non-multipart content type', async () => {
    mockSession({ npiOrgId: 'org1', npiUserId: 'user1' });
    mockDb();
    const { POST } = require('../src/app/api/documents/route');
    const { NextRequest } = require('next/server');

    const req = new NextRequest('http://localhost/copilot/api/documents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    const res = await POST(req);
    expect(res.status).toBe(415);
  });

  it('GET returns 404 for an unknown id', async () => {
    mockSession({ npiOrgId: 'org1', npiUserId: 'user1' });
    mockDb();
    const { GET } = require('../src/app/api/documents/route');
    const { NextRequest } = require('next/server');

    const req = new NextRequest('http://localhost/copilot/api/documents?id=nope');
    const res = await GET(req);
    expect(res.status).toBe(404);
  });

  it('GET returns 200 with the summary for a document the caller owns', async () => {
    mockSession({ npiOrgId: 'org1', npiUserId: 'user1' });
    const { rows } = mockDb();
    const now = new Date();
    rows.push({
      id: 'doc-abc',
      npiOrgId: 'org1',
      npiUserId: 'user1',
      fileName: 'a.jpg',
      mime: 'image/jpeg',
      sizeBytes: 10,
      sha256: 'x'.repeat(64),
      storagePath: `org1/${'x'.repeat(64)}.jpg`,
      kind: 'image',
      sensitivityFlag: false,
      consentEventId: null,
      extractedTextRedactedRef: null,
      createdAt: now,
      updatedAt: now,
    });
    const { GET } = require('../src/app/api/documents/route');
    const { NextRequest } = require('next/server');

    const req = new NextRequest('http://localhost/copilot/api/documents?id=doc-abc');
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.document.id).toBe('doc-abc');
  });
});
