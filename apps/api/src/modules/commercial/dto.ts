import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

const ITEM_CATEGORIES = ['MODULE', 'INVERTER', 'MOUNTING', 'CABLE', 'BOS', 'SPARE', 'SERVICE'] as const;
const CONTRACT_TYPES = ['EPC', 'PPA', 'OM', 'LEASE'] as const;
const MILESTONE_TRIGGER_TYPES = ['DATE', 'PROGRESS', 'EVENT'] as const;

// ─── Items ───────────────────────────────────────────────────────────────
export class CreateItemDto {
  @IsString() @MinLength(1) sku!: string;
  @IsString() @MinLength(1) nameAr!: string;
  @IsString() @MinLength(1) nameEn!: string;
  @IsEnum(ITEM_CATEGORIES) itemCategory!: (typeof ITEM_CATEGORIES)[number];
  @IsOptional() @IsString() uom?: string;
  @IsOptional() @IsBoolean() isSerialised?: boolean;
  @IsOptional() @IsNumber() @Min(0) unitCost?: number;
}

export class UpdateItemDto {
  @IsOptional() @IsString() nameAr?: string;
  @IsOptional() @IsString() nameEn?: string;
  @IsOptional() @IsEnum(ITEM_CATEGORIES) itemCategory?: (typeof ITEM_CATEGORIES)[number];
  @IsOptional() @IsString() uom?: string;
  @IsOptional() @IsBoolean() isSerialised?: boolean;
  @IsOptional() @IsNumber() @Min(0) unitCost?: number;
}

// ─── Proposals & BOM ──────────────────────────────────────────────────────
export class CreateProposalDto {
  @IsString() opportunityId!: string;
  @IsOptional() @IsString() currency?: string;
}

export class BomLineDto {
  @IsString() itemId!: string;
  @IsNumber() @Min(0) qty!: number;
  @IsNumber() @Min(0) unitPrice!: number;
  @IsOptional() @IsBoolean() isAdder?: boolean;
}

export class DesignVersionInputDto {
  @IsOptional() @IsString() sourceTool?: string;
  @IsOptional() @IsString() externalRef?: string;
  @IsOptional() @IsNumber() @Min(0) capacityKwp?: number;
  @IsOptional() @IsNumber() @Min(0) expectedAnnualKwh?: number;
}

export class CreateRevisionDto {
  @IsOptional() @IsString() pricingSchemeId?: string;
  @IsOptional() @IsNumber() @Min(0) marginPct?: number;
  @IsOptional() @ValidateNested() @Type(() => DesignVersionInputDto)
  designVersion?: DesignVersionInputDto;
  @IsArray() @ValidateNested({ each: true }) @Type(() => BomLineDto)
  bomLines!: BomLineDto[];
}

// ─── Contracts & milestones ───────────────────────────────────────────────
export class MilestoneInputDto {
  @IsNumber() sequence!: number;
  @IsString() @MinLength(1) descriptionAr!: string;
  @IsString() @MinLength(1) descriptionEn!: string;
  @IsOptional() @IsEnum(MILESTONE_TRIGGER_TYPES) triggerType?: (typeof MILESTONE_TRIGGER_TYPES)[number];
  @IsNumber() @Min(0) amount!: number;
  @IsOptional() @IsString() dueDate?: string;
}

export class CreateContractDto {
  // Either supply a winning proposal revision to inherit customer + value…
  @IsOptional() @IsString() proposalRevisionId?: string;
  // …or supply the customer directly for a standalone contract.
  @IsOptional() @IsString() customerId?: string;
  @IsEnum(CONTRACT_TYPES) contractType!: (typeof CONTRACT_TYPES)[number];
  @IsOptional() @IsString() startDate?: string;
  @IsOptional() @IsString() endDate?: string;
  @IsOptional() @IsNumber() @Min(0) totalValue?: number;
  @IsOptional() @IsNumber() @Min(0) retentionPct?: number;
  @IsOptional() @IsNumber() @Min(0) advancePct?: number;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => MilestoneInputDto)
  milestones?: MilestoneInputDto[];
}

export class VerifyMilestoneDto {
  @IsString() milestoneId!: string;
}
