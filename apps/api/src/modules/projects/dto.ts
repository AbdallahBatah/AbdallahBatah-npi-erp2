import { IsEnum, IsNumber, IsOptional, IsString, Min } from 'class-validator';

const PROJECT_STAGES = ['PLANNING', 'PROCUREMENT', 'EXECUTION', 'COMMISSIONING', 'CLOSED'] as const;

export class CreateProjectDto {
  @IsString() contractId!: string;
  @IsOptional() @IsString() nameAr?: string;
  @IsOptional() @IsString() nameEn?: string;
  @IsOptional() @IsString() siteRef?: string;
  @IsOptional() @IsNumber() @Min(0) capacityKwp?: number;
  @IsOptional() @IsString() plannedStart?: string;
  @IsOptional() @IsString() plannedEnd?: string;
}

export class SetStageDto {
  @IsEnum(PROJECT_STAGES) stage!: (typeof PROJECT_STAGES)[number];
}

// PRJ-06: a variation priced as a signed delta on the contract value.
export class CreateChangeOrderDto {
  @IsString() descriptionAr!: string;
  @IsString() descriptionEn!: string;
  @IsNumber() amountDelta!: number; // + addition / − omission
  @IsOptional() @IsNumber() scheduleImpactDays?: number;
  @IsOptional() @IsString() wbsElementId?: string;
}

// Package 4 · P4-1 (ADR-04 §4-1): the engineer and the planned dates.
export class AssignProjectDto {
  /** A user of the organization; an empty string unassigns. */
  @IsOptional() @IsString() engineerId?: string;
  @IsOptional() @IsString() plannedStart?: string | null;
  @IsOptional() @IsString() plannedEnd?: string | null;
}

export class PlanElementDto {
  @IsOptional() @IsString() plannedStart?: string | null;
  @IsOptional() @IsString() plannedEnd?: string | null;
}
