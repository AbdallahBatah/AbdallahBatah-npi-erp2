import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

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

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsIn(['AR', 'EN'])
  locale?: 'AR' | 'EN';
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
  @MaxLength(50)
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
