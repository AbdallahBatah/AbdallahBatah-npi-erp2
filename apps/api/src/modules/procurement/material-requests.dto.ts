import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

// ─── Package 4 · P4-2 / P4-3 (ADR-04 §4-2, §4-3) ────────────────────────

export class MaterialRequestLineDto {
  @IsString() itemId!: string;
  /** The project's budget line the material is for. */
  @IsOptional() @IsString() wbsElementId?: string;
  @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) qty!: number;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class CreateMaterialRequestDto {
  @IsString() projectId!: string;
  @IsOptional() @IsDateString() neededBy?: string;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
  @IsArray() @ArrayNotEmpty() @ValidateNested({ each: true }) @Type(() => MaterialRequestLineDto)
  lines!: MaterialRequestLineDto[];
}

export class UpdateMaterialRequestDto {
  @IsOptional() @IsDateString() neededBy?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string | null;
  @IsOptional() @IsArray() @ArrayNotEmpty() @ValidateNested({ each: true }) @Type(() => MaterialRequestLineDto)
  lines?: MaterialRequestLineDto[];
}

export class RejectMaterialRequestDto {
  @IsString() @MinLength(3) @MaxLength(1000) note!: string;
}

export class IssueLineDto {
  @IsString() requestLineId!: string;
  @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) qty!: number;
  /** A serialised item: the exact units sent; their count must equal qty. */
  @IsOptional() @IsArray() @IsString({ each: true }) serialUnitIds?: string[];
}

export class CreateMaterialIssueDto {
  /** The store the materials leave from. The destination is the project's site location. */
  @IsString() fromLocationId!: string;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @IsArray() @ArrayNotEmpty() @ValidateNested({ each: true }) @Type(() => IssueLineDto)
  lines!: IssueLineDto[];
}

export class RaiseShortageDto {
  /** Why purchasing is needed — becomes the requisition's justification. */
  @IsOptional() @IsString() @MinLength(3) @MaxLength(1000) justification?: string;
}
