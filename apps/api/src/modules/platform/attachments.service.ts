import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createReadStream, promises as fs } from 'fs';
import { randomUUID } from 'crypto';
import * as path from 'path';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../common/audit.service';
import { AttachmentEntity } from '@npi/db';
import type { AuthUser } from '../../common/auth-user';

/** Root folder for stored files — a docker volume in production. */
export function uploadsDir(): string {
  return process.env.UPLOADS_DIR ?? path.join(process.cwd(), 'uploads');
}

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

// Whitelist by extension — the extension drives what a browser will do with a
// downloaded file, so it is the safety boundary (mimeType is stored as-is for
// display only).
const ALLOWED_EXTENSIONS = new Set([
  '.pdf', '.png', '.jpg', '.jpeg', '.webp',
  '.xlsx', '.docx', '.csv', '.txt', '.zip', '.dwg',
]);

// Uploading to an entity requires being able to see that entity at all —
// holding platform.attachment.* alone must not leak documents across modules.
const ENTITY_READ_PERMISSION: Record<AttachmentEntity, string> = {
  CONTRACT: 'commercial.contract.read',
  INVOICE: 'finance.invoice.read',
  PROJECT: 'projects.project.read',
  WORK_ORDER: 'fsm.workorder.read',
  CUSTOMER: 'crm.customer.read',
  OPPORTUNITY: 'crm.opportunity.read',
};

@Injectable()
export class AttachmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private parseEntityType(raw: string): AttachmentEntity {
    const key = raw.toUpperCase() as AttachmentEntity;
    if (!Object.values(AttachmentEntity).includes(key)) {
      throw new BadRequestException(`Unknown attachment entity type '${raw}'`);
    }
    return key;
  }

  private requireEntityAccess(user: AuthUser, entityType: AttachmentEntity) {
    if (!user.permissions.includes(ENTITY_READ_PERMISSION[entityType])) {
      throw new ForbiddenException('Insufficient permissions');
    }
  }

  /** 404 unless the parent row exists inside the caller's organization. */
  private async assertEntityExists(user: AuthUser, entityType: AttachmentEntity, entityId: string) {
    const where = { id: entityId, organizationId: user.organizationId };
    const found =
      entityType === 'CONTRACT' ? await this.prisma.contract.findFirst({ where, select: { id: true } })
      : entityType === 'INVOICE' ? await this.prisma.invoice.findFirst({ where, select: { id: true } })
      : entityType === 'PROJECT' ? await this.prisma.project.findFirst({ where, select: { id: true } })
      : entityType === 'CUSTOMER' ? await this.prisma.customer.findFirst({ where, select: { id: true } })
      : entityType === 'OPPORTUNITY' ? await this.prisma.opportunity.findFirst({ where, select: { id: true } })
      : await this.prisma.workOrder.findFirst({ where, select: { id: true } });
    if (!found) throw new NotFoundException('Entity not found');
  }

  async list(user: AuthUser, rawType: string, entityId: string) {
    const entityType = this.parseEntityType(rawType);
    this.requireEntityAccess(user, entityType);
    return this.prisma.attachment.findMany({
      where: { organizationId: user.organizationId, entityType, entityId },
      orderBy: { createdAt: 'desc' },
      include: { uploadedBy: { select: { nameAr: true, nameEn: true } } },
    });
  }

  async upload(user: AuthUser, rawType: string, entityId: string, file?: Express.Multer.File) {
    const entityType = this.parseEntityType(rawType);
    this.requireEntityAccess(user, entityType);
    if (!file || !file.buffer?.length) throw new BadRequestException('No file uploaded');
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new BadRequestException('File exceeds the 10 MB limit');
    }
    // Multer decodes multipart filenames as latin1 — restore UTF-8 (Arabic names).
    const fileName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const ext = path.extname(fileName).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      throw new BadRequestException(`File type '${ext || '?'}' is not allowed`);
    }
    await this.assertEntityExists(user, entityType, entityId);

    // Server-generated key: client input never reaches the filesystem path.
    const storageKey = path.posix.join(user.organizationId, `${randomUUID()}${ext}`);
    const absolute = path.join(uploadsDir(), storageKey);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, file.buffer);

    const attachment = await this.prisma.attachment.create({
      data: {
        organizationId: user.organizationId,
        entityType,
        entityId,
        fileName,
        mimeType: file.mimetype || 'application/octet-stream',
        sizeBytes: file.size,
        storageKey,
        uploadedById: user.userId,
      },
      include: { uploadedBy: { select: { nameAr: true, nameEn: true } } },
    });
    await this.audit.record({
      organizationId: user.organizationId,
      actorId: user.userId,
      entityType: 'Attachment',
      entityId: attachment.id,
      action: 'CREATE',
      after: { entityType, entityId, fileName, sizeBytes: file.size },
    });
    return attachment;
  }

  private async getOwned(user: AuthUser, id: string) {
    const attachment = await this.prisma.attachment.findFirst({
      where: { id, organizationId: user.organizationId },
    });
    if (!attachment) throw new NotFoundException('Attachment not found');
    this.requireEntityAccess(user, attachment.entityType);
    return attachment;
  }

  /** Returns the stream plus headers material; the controller sets the response up. */
  async download(user: AuthUser, id: string) {
    const attachment = await this.getOwned(user, id);
    const absolute = path.join(uploadsDir(), attachment.storageKey);
    try {
      await fs.access(absolute);
    } catch {
      throw new NotFoundException('Stored file is missing');
    }
    return { attachment, stream: createReadStream(absolute) };
  }

  async remove(user: AuthUser, id: string) {
    const attachment = await this.getOwned(user, id);
    await this.prisma.attachment.delete({ where: { id: attachment.id } });
    // Best-effort unlink — the DB row is the source of truth; an orphan file
    // is harmless, a dangling row is not.
    await fs.unlink(path.join(uploadsDir(), attachment.storageKey)).catch(() => undefined);
    await this.audit.record({
      organizationId: user.organizationId,
      actorId: user.userId,
      entityType: 'Attachment',
      entityId: attachment.id,
      action: 'DELETE',
      before: { entityType: attachment.entityType, entityId: attachment.entityId, fileName: attachment.fileName },
    });
    return { ok: true };
  }
}
