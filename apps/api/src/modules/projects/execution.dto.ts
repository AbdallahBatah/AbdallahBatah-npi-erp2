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

// ─── Package 5 (ADR-05) ───────────────────────────────────────────────────

export class ProgressLineDto {
  @IsString() wbsElementId!: string;
  @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) qty!: number;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

/** One day's executed quantities, one line per budget line touched. */
export class RecordProgressDto {
  @IsDateString() workDate!: string;
  @IsArray() @ArrayNotEmpty() @ValidateNested({ each: true }) @Type(() => ProgressLineDto)
  lines!: ProgressLineDto[];
}

export class RequestOverrunDto {
  @IsString() wbsElementId!: string;
  @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) extraQty!: number;
  @IsString() @MinLength(5) @MaxLength(1000) reason!: string;
}

export class AttendanceDto {
  @IsDateString() workDate!: string;
  @IsString() @MinLength(2) @MaxLength(120) workerName!: string;
  /** The worker's role on site (electrician, installer, driver…). */
  @IsOptional() @IsString() @MaxLength(80) trade?: string;
  @IsDateString() checkInAt!: string;
  @IsOptional() @IsDateString() checkOutAt?: string;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class CheckOutDto {
  @IsDateString() checkOutAt!: string;
}
