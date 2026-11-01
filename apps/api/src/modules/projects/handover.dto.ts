import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

// ─── Package 7 (ADR-07) ───────────────────────────────────────────────────

export class CheckItemDto {
  @IsString() key!: string;
  @IsBoolean() ok!: boolean;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class ReadingDto {
  @IsString() @MaxLength(60) label!: string;
  @IsString() @MaxLength(40) value!: string;
  @IsOptional() @IsString() @MaxLength(10) unit?: string;
}

export class SaveHandoverDto {
  @IsOptional() @IsDateString() completionDate?: string;
  @IsOptional() @IsDateString() commissionedAt?: string;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => CheckItemDto) checklist?: CheckItemDto[];
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ReadingDto) readings?: ReadingDto[];
  @IsOptional() @IsString() @MaxLength(2000) snags?: string;
  @IsOptional() @IsDateString() snagsDueDate?: string;
  @IsOptional() @IsString() @MaxLength(120) clientRepName?: string;
  /** { PANELS_PRODUCT: 12, … } */
  @IsOptional() @IsObject() warrantyYears?: Record<string, number>;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

export class WarrantyYearsDto {
  @IsInt() @Min(1) @Max(40) years!: number;
}

export class SubmitHandoverDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(1000) comment?: string;
}
