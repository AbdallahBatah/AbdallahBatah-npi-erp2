import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ALL_PERMISSIONS, SAUDI_VAT_OR_EMPTY_RE, type PermissionEffect } from '@npi/shared';

export class CreateUserDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;

  @IsString()
  @MaxLength(120)
  nameAr!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  nameEn?: string;

  @IsString()
  roleId!: string;

  /** Roles held in addition to `roleId` (CRM Phase 1). Never includes the primary. */
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  extraRoleIds?: string[];

  @IsOptional()
  @IsIn(['AR', 'EN'])
  locale?: 'AR' | 'EN';
}

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  nameAr?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  nameEn?: string;

  @IsOptional()
  @IsString()
  roleId?: string;

  /** When present, REPLACES the user's whole set of extra roles. [] clears it. */
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  extraRoleIds?: string[];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsIn(['AR', 'EN'])
  locale?: 'AR' | 'EN';
}

/** One per-user exception: a key added to the user's roles, or taken away (ADR-02 §3-1). */
export class PermissionOverrideDto {
  @IsIn(ALL_PERMISSIONS, { message: 'Unknown permission key: $value' })
  permission!: string;

  @IsIn(['GRANT', 'DENY'])
  effect!: PermissionEffect;

  /** Optional for now (one administrator; a mandatory field would be filled with noise). */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string | null;
}

/** PUT /admin/users/:id/permissions — REPLACES the whole set; [] clears it. */
export class SetUserPermissionsDto {
  @IsArray()
  @ArrayUnique((o: PermissionOverrideDto) => o?.permission, {
    message: 'Overrides must not name the same permission twice',
  })
  @ValidateNested({ each: true })
  @Type(() => PermissionOverrideDto)
  overrides!: PermissionOverrideDto[];
}

export class ResetPasswordDto {
  @IsString()
  @MinLength(8)
  newPassword!: string;
}

export class CreateRoleDto {
  /** Stable identifier, e.g. 'warehouse_keeper'. Lowercase slug. */
  @IsString()
  @Matches(/^[a-z][a-z0-9_]{1,39}$/, {
    message: 'key must be a lowercase slug (letters, digits, underscore)',
  })
  key!: string;

  @IsString()
  @MaxLength(120)
  nameAr!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  nameEn?: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  permissions!: string[];
}

export class UpdateRoleDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  nameAr?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  nameEn?: string;

  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  permissions?: string[];
}

export class UpdateOrgDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  legalNameAr?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  legalNameEn?: string;

  @IsOptional()
  @IsString()
  @Matches(SAUDI_VAT_OR_EMPTY_RE, {
    message: 'vatNumber must be a Saudi VAT number (15 digits starting and ending with 3)',
  })
  vatNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  crNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(400)
  addressAr?: string;

  @IsOptional()
  @IsString()
  @MaxLength(400)
  addressEn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  website?: string;

  /** Data URL (data:image/...;base64,...) capped well under the 1mb JSON body limit. Empty string clears the logo. */
  @IsOptional()
  @IsString()
  @MaxLength(700_000)
  @Matches(/^(data:image\/(png|jpeg|jpg|webp|svg\+xml);base64,.+)?$/, {
    message: 'logoDataUrl must be a base64 image data URL',
  })
  logoDataUrl?: string;
}
