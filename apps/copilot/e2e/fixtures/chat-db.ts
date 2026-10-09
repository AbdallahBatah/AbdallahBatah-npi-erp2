// Database fixture for the chat specs (T-39b, D-23): seeds the caller's latest
// conversation — its messages, the intake jobs the history's cards are drawn
// from, and the documents those jobs attach (row plus `.meta.json` sidecar) —
// and removes all of it afterwards.
//
// Why: from T-39b on `/copilot` reads the history ON THE SERVER (from the
// copilot's own database) and renders it in the first HTML; the browser sends
// no history GET, so mocking `GET /copilot/api/chat` with `page.route` no
// longer controls what the chat shows. The settings and setup specs already
// drive the server through database fixtures (`settings-db.ts`, `setup-db.ts`);
// this one puts the chat specs on the same footing. The rows are written in
// the shape the product writes them (`src/chat/history.ts` reads them back,
// `src/intake/job.ts` turns a job into its view), so `getIntakeView` on a
// seeded job returns exactly the `IntakeView` the spec built it from.
//
// Uses the copilot's own Prisma client and document store — never NPI's
// database (08 §E.10) — with the same `.env` loading `tests/helpers/load-env.ts`
// does for Jest. Never logs the connection URL.
import '../../tests/helpers/load-env';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { APIRequestContext } from '@playwright/test';
import type { ChatMessage } from '../../src/components/chat/api';
import { PrismaClient, type Prisma } from '../../src/generated/prisma';
import type { IntakeView, StoredPreview } from '../../src/intake/types';
import { createFsStorage, docsRoot, metaSidecarPath, orgDirName, type DocumentMeta } from '../../src/intake/upload';
import type { SeededAccount } from './accounts';

const API_PORT = process.env.COPILOT_E2E_API_PORT ?? '4077';
const API_BASE = `http://localhost:${API_PORT}/api`;

let client: PrismaClient | undefined;

function getClient(): PrismaClient {
  if (!client) client = new PrismaClient();
  return client;
}

/** A history message exactly as the browser receives it (`GET /copilot/api/chat`). */
export type HistoryMessage = ChatMessage;

export interface ChatSeed {
  /** The conversation row's id (default `conv-1`, the id the fixture views carry). */
  conversationId?: string;
  messages: HistoryMessage[];
  /** The intake jobs the history's messages point at (`intakeJobId`). */
  jobs?: IntakeView[];
}

export interface ChatFixtureHandle {
  conversationId: string;
  messageIds: string[];
  jobIds: string[];
  documentIds: string[];
  /** Storage-relative paths (under `docsRoot()`) of the `.meta.json` sidecars written. */
  sidecarPaths: string[];
}

export interface NpiIdentity {
  npiOrgId: string;
  npiUserId: string;
}

/** The NPI organization and user id of a seeded account: the copilot session
 *  carries the same ids, so rows written under them are the account's own. */
export async function npiIdentity(request: APIRequestContext, account: SeededAccount): Promise<NpiIdentity> {
  const res = await request.post(`${API_BASE}/auth/login`, { data: { email: account.email, password: account.password } });
  if (!res.ok()) throw new Error(`chat-db: NPI login failed for ${account.email} (HTTP ${res.status()})`);
  const body = (await res.json()) as { user: { id: string; organization: { id: string } } };
  return { npiOrgId: body.user.organization.id, npiUserId: body.user.id };
}

const asJson = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;

/** Where a sidecar lives on disk: the store's own root plus the relative path. */
function sidecarFile(relPath: string): string {
  const segments = relPath.split(/[\\/]/).filter((s) => s.length > 0);
  if (path.isAbsolute(relPath) || segments.includes('..')) throw new Error(`chat-db: unsafe storage path "${relPath}"`);
  return path.join(docsRoot(), ...segments);
}

/** Deletes the rows (and sidecars) a crashed earlier run left under these ids,
 *  children first. Also the clean-up of `restoreChatFixture`. */
async function removeRows(handle: ChatFixtureHandle): Promise<void> {
  const db = getClient();
  const { conversationId, messageIds, jobIds, documentIds } = handle;

  const documents = await db.document.findMany({ where: { id: { in: documentIds } }, select: { storagePath: true } });
  await db.message.deleteMany({
    where: { OR: [{ id: { in: messageIds } }, { conversationId }, ...(jobIds.length > 0 ? [{ intakeJobId: { in: jobIds } }] : [])] },
  });
  await db.intakeJob.deleteMany({ where: { id: { in: jobIds } } });
  await db.conversation.deleteMany({ where: { id: conversationId } });
  await db.document.deleteMany({ where: { id: { in: documentIds } } });

  for (const { storagePath } of documents) await fs.rm(sidecarFile(metaSidecarPath(storagePath)), { force: true });
  for (const relPath of handle.sidecarPaths) await fs.rm(sidecarFile(relPath), { force: true });
}

/**
 * Makes the identity's latest conversation the one described by `seed`:
 * (a) clears what a crashed run left under the same ids, (b) one `documents`
 * row plus its `.meta.json` sidecar per job that has a document (a fresh
 * random `sha256`, because the table is unique per organization, user and
 * hash; `storagePath` formed the way `uploadDocument` forms it), (b') the
 * `conversations` row (created now, so it is the caller's newest), (c) one
 * `intake_jobs` row per job, (d) the messages.
 */
export async function seedLatestConversation(identity: NpiIdentity, seed: ChatSeed): Promise<ChatFixtureHandle> {
  const db = getClient();
  const conversationId = seed.conversationId ?? 'conv-1';
  const jobs = seed.jobs ?? [];
  const handle: ChatFixtureHandle = {
    conversationId,
    messageIds: seed.messages.map((m) => m.id),
    jobIds: jobs.map((j) => j.id),
    documentIds: jobs.flatMap((j) => (j.document ? [j.document.id] : [])),
    sidecarPaths: [],
  };

  await removeRows(handle);

  const storage = createFsStorage(docsRoot());
  const orgDir = orgDirName(identity.npiOrgId);
  for (const job of jobs) {
    if (!job.document) continue;
    const sha256 = randomBytes(32).toString('hex');
    const isPdf = job.document.kind !== 'image';
    const storagePath = `${orgDir}/${sha256}.${isPdf ? 'pdf' : 'png'}`;
    const meta: DocumentMeta = {
      pageCount: job.document.pageCount,
      textChars: job.document.kind === 'pdf_text' ? 900 : null,
      rasterPages: job.document.kind === 'pdf_scanned' ? job.document.pageCount : 0,
    };
    await storage.write(metaSidecarPath(storagePath), new TextEncoder().encode(JSON.stringify(meta)));
    handle.sidecarPaths.push(metaSidecarPath(storagePath));
    await db.document.create({
      data: {
        id: job.document.id,
        npiOrgId: identity.npiOrgId,
        npiUserId: identity.npiUserId,
        fileName: job.document.fileName,
        mime: isPdf ? 'application/pdf' : 'image/png',
        sizeBytes: 1,
        sha256,
        storagePath,
        kind: job.document.kind,
      },
    });
  }

  await db.conversation.create({
    data: { id: conversationId, npiOrgId: identity.npiOrgId, npiUserId: identity.npiUserId, titleAr: 'e2e chat fixture' },
  });

  for (const job of jobs) {
    // `StoredPreview` in full: the view's `preview` is its `.model`.
    const stored: StoredPreview | null = job.preview
      ? { resolution: null, choices: {}, confirmed: [], fields: {}, model: job.preview }
      : null;
    await db.intakeJob.create({
      data: {
        id: job.id,
        npiOrgId: identity.npiOrgId,
        npiUserId: identity.npiUserId,
        documentId: job.document?.id ?? null,
        conversationId,
        flowType: job.flow,
        status: job.status,
        previewJson: stored ? asJson(stored) : undefined,
        executionLogJson: job.execution ? asJson(job.execution) : undefined,
        error: job.failureAr,
        approvedAt: job.approvedAt ? new Date(job.approvedAt) : null,
        createdAt: new Date(job.createdAt),
      },
    });
  }

  for (const m of seed.messages) {
    await db.message.create({
      data: {
        id: m.id,
        conversationId,
        role: m.role,
        contentAr: m.textAr,
        badge: m.badges.length > 0 ? m.badges.join('، ') : null,
        kind: m.kind ?? null,
        memoryNoteJson: asJson(m.memoryNotes),
        intakeJobId: m.intakeJobId ?? null,
        documentId: m.documentId ?? null,
        createdAt: new Date(m.createdAt),
      },
    });
  }

  return handle;
}

/** Undoes `seedLatestConversation`: messages, jobs, the conversation, the
 *  documents, then the sidecar files. An undefined handle (a test whose seed
 *  never ran) is a no-op. */
export async function restoreChatFixture(handle: ChatFixtureHandle | undefined): Promise<void> {
  if (!handle) return;
  await removeRows(handle);
}

/** Closes the fixture's own Prisma connection — call once, from `afterAll`. */
export async function disconnectChatDb(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = undefined;
  }
}
