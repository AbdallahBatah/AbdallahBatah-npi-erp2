import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDateString,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * The two M4 organisation-structure resources the schema shipped without an
 * HTTP surface: departments (the unit an approval rule can be scoped to) and
 * temporary delegations (the "إجازات المعتمدين" case).
 */

export class CreateDepartmentDto {
  /** Stable short code, unique per organization. Uppercase slug. */
  @IsString()
  @Matches(/^[A-Z][A-Z0-9_-]{1,19}$/, {
    message: 'code must be an uppercase slug (letters, digits, underscore, dash)',
  })
  code!: string;

  @IsString() @MinLength(2) @MaxLength(120) nameAr!: string;

  @IsOptional() @IsString() @MaxLength(120) nameEn?: string;

  @IsOptional() @IsString() parentId?: string | null;

  @IsOptional() @IsString() managerId?: string | null;

  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class UpdateDepartmentDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120) nameAr?: string;

  @IsOptional() @IsString() @MaxLength(120) nameEn?: string;

  /** Explicit null detaches the department from its parent. */
  @IsOptional() @IsString() parentId?: string | null;

  /** Explicit null clears the manager. */
  @IsOptional() @IsString() managerId?: string | null;

  @IsOptional() @IsBoolean() isActive?: boolean;
}

/**
 * The whole membership of one department, sent as a set rather than as
 * add/remove deltas: the screen shows a checkbox list, and a set assignment is
 * the only shape that cannot lose a concurrent edit halfway.
 */
export class SetDepartmentMembersDto {
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  userIds!: string[];
}

export class CreateDelegationDto {
  @IsString() fromUserId!: string;

  @IsString() toUserId!: string;

  @IsDateString() startsAt!: string;

  @IsDateString() endsAt!: string;

  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}
