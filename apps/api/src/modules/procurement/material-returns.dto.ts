import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

// ─── Package 5 · P5-4 (ADR-05) — إذن مرتجع مواد ──────────────────────────

export class MaterialReturnLineDto {
  @IsString() itemId!: string;
  @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) qty!: number;
  /** A serialised item: the exact units sent back (their count = qty). */
  @IsOptional() @IsArray() @IsString({ each: true }) serialUnitIds?: string[];
}

export class CreateMaterialReturnDto {
  @IsString() projectId!: string;
  /** The store it goes back to; defaults to the main (first) warehouse. */
  @IsOptional() @IsString() toLocationId?: string;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @IsArray() @ArrayNotEmpty() @ValidateNested({ each: true }) @Type(() => MaterialReturnLineDto)
  lines!: MaterialReturnLineDto[];
}

export class ReceiveMaterialReturnDto {
  /** The keeper may put it in another store than the one named. */
  @IsOptional() @IsString() toLocationId?: string;
}
