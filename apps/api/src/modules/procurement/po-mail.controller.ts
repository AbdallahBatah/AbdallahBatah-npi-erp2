import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { ArrayMaxSize, IsArray, IsBoolean, IsOptional, IsString } from 'class-validator';
import { PERMISSIONS } from '@npi/shared';
import { PoMailService } from './po-mail.service';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import type { AuthUser } from '../../common/auth-user';

export class EmailPoDto {
  /** Overrides the vendor's own address. */
  @IsOptional() @IsArray() @ArrayMaxSize(5) @IsString({ each: true }) to?: string[];
  /** Also perform «send to vendor» on an approved order. */
  @IsOptional() @IsBoolean() markSent?: boolean;
}

@Controller('procurement')
@UseGuards(PermissionsGuard)
export class PoMailController {
  constructor(private readonly mail: PoMailService) {}

  @Post('purchase-orders/:id/email')
  @RequirePermissions(PERMISSIONS.PROCUREMENT_WRITE)
  email(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: EmailPoDto) {
    return this.mail.email(user, id, dto);
  }
}
