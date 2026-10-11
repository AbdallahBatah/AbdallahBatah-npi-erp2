import {
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { AttachmentsService, MAX_UPLOAD_BYTES } from './attachments.service';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { PERMISSIONS } from '@npi/shared';
import type { AuthUser } from '../../common/auth-user';

@Controller('attachments')
@UseGuards(PermissionsGuard)
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  // Declared before list: ':id/download' and ':entityType/:entityId' are both
  // two segments, and Nest matches in declaration order — the literal
  // 'download' tail must win.
  @Get(':id/download')
  @RequirePermissions(PERMISSIONS.ATTACHMENT_READ)
  async download(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    const { attachment, stream } = await this.attachments.download(user, id);
    // RFC 5987 filename* so Arabic names survive the round-trip.
    const encoded = encodeURIComponent(attachment.fileName).replaceAll("'", '%27');
    res.setHeader('Content-Type', attachment.mimeType);
    res.setHeader('Content-Length', String(attachment.sizeBytes));
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encoded}`);
    stream.pipe(res);
  }

  @Get(':entityType/:entityId')
  @RequirePermissions(PERMISSIONS.ATTACHMENT_READ)
  list(
    @CurrentUser() user: AuthUser,
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
  ) {
    return this.attachments.list(user, entityType, entityId);
  }

  @Post(':entityType/:entityId')
  @RequirePermissions(PERMISSIONS.ATTACHMENT_WRITE)
  // Memory storage: the service validates then writes under its own key —
  // multer never touches the final path. fileSize is enforced by multer too
  // (it fails the request before buffering more than the limit).
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  upload(
    @CurrentUser() user: AuthUser,
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.attachments.upload(user, entityType, entityId, file);
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.ATTACHMENT_WRITE)
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.attachments.remove(user, id);
  }
}
