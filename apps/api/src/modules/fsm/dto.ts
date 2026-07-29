import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

const WO_TYPES = ['CORRECTIVE', 'PREVENTIVE', 'CLEANING', 'INSPECTION', 'COMMISSIONING'] as const;
const WO_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;

export class CreateWorkOrderDto {
  @IsString() @MinLength(1) titleAr!: string;
  @IsString() @MinLength(1) titleEn!: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsEnum(WO_TYPES) woType?: (typeof WO_TYPES)[number];
  @IsOptional() @IsEnum(WO_PRIORITIES) priority?: (typeof WO_PRIORITIES)[number];
  @IsOptional() @IsString() assetId?: string;
  @IsOptional() @IsString() projectId?: string;
  @IsOptional() @IsString() scheduledAt?: string;
  @IsOptional() @IsString() slaDueAt?: string;
  @IsOptional() @IsString() assignedToId?: string;
}

export class AssignDto {
  @IsString() assignedToId!: string;
  @IsOptional() @IsString() scheduledAt?: string;
}

export class AddPartDto {
  @IsString() itemId!: string;
  @IsNumber() @Min(0.001) qty!: number;
  @IsString() fromLocationId!: string;
}

export class ChecklistItemResultDto {
  @IsString() label!: string;
  @IsBoolean() done!: boolean;
  @IsOptional() @IsString() note?: string;
  // Bilingual labels + mandatory flag round-trip from the plan template so
  // matching works in either language and the record stays bilingual.
  @IsOptional() @IsString() labelAr?: string;
  @IsOptional() @IsString() labelEn?: string;
  @IsOptional() @IsBoolean() mandatory?: boolean;
}

export class CompleteDto {
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ChecklistItemResultDto)
  checklist?: ChecklistItemResultDto[];
}

export class ChecklistTemplateItemDto {
  @IsString() labelAr!: string;
  @IsString() labelEn!: string;
  @IsOptional() @IsBoolean() mandatory?: boolean;
}

// FSM-09: warranty claims
export class CreateWarrantyClaimDto {
  @IsString() serialUnitId!: string;
  @IsString() @MinLength(1) defectAr!: string;
  @IsString() @MinLength(1) defectEn!: string;
  @IsOptional() @IsString() workOrderId?: string;
}

export class ReplaceSerialDto {
  @IsString() replacementSerialUnitId!: string;
}

// FSM-07: labour time
export class AddTimeDto {
  @IsNumber() @Min(0.25) hours!: number;
  @IsNumber() @Min(0) hourlyRate!: number;
  @IsOptional() @IsString() userId?: string;
  @IsOptional() @IsString() workDate?: string;
  @IsOptional() @IsString() memo?: string;
}

export class CreatePlanDto {
  @IsString() @MinLength(1) nameAr!: string;
  @IsString() @MinLength(1) nameEn!: string;
  @IsOptional() @IsString() assetId?: string;
  @IsOptional() @IsString() projectId?: string;
  @IsInt() @Min(1) intervalDays!: number;
  @IsOptional() @IsString() firstDueAt?: string;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ChecklistTemplateItemDto)
  checklist?: ChecklistTemplateItemDto[];
}
