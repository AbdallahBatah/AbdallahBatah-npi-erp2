import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class ReadingDto {
  @IsString() assetId!: string;
  /** ISO date (day granularity). */
  @IsString() readingDate!: string;
  @IsNumber() @Min(0) energyKwh!: number;
  @IsOptional() @IsNumber() @Min(0) expectedKwh?: number;
  @IsOptional() @IsString() source?: string;
}

export class IngestDto {
  /** Bounded: ingestion loops per reading — an unbounded array is a DoS lever. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ReadingDto)
  readings!: ReadingDto[];
}

export class SimulateDto {
  @IsString() projectId!: string;
  @IsInt() @Min(1) @Max(60) days!: number;
  /** Index (from the end) of a deliberately bad day, to exercise the alert path. */
  @IsOptional() @IsInt() @Min(0) badDayOffset?: number;
}
