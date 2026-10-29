import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

const ITEM_CATEGORIES = ['MODULE', 'INVERTER', 'MOUNTING', 'CABLE', 'BOS', 'SPARE', 'SERVICE'] as const;
const CONTRACT_TYPES = ['EPC', 'PPA', 'OM', 'LEASE'] as const;
const MILESTONE_TRIGGER_TYPES = ['DATE', 'PROGRESS', 'EVENT'] as const;
export const WORK_ITEM_KINDS = ['MATERIAL', 'LABOUR', 'EQUIPMENT', 'SUBCONTRACT', 'EXPENSE', 'FINANCING'] as const;

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

export const PRICING_MODES = ['PER_LINE', 'LUMP_SUM'] as const;

/**
 * One line of a revision — since Package 3 (ADR-03 §4-4) one line of the
 * estimated budget. It names a work item, a stock item, or both (a MATERIAL
 * work item brings its own stock item); at least one is required.
 */
export class BomLineDto {
  @IsOptional() @IsString() itemId?: string;
  /** Package 3 · P3-4: the project work item this line is. */
  @IsOptional() @IsString() workItemId?: string;
  /** The line's wording on the budget, when it differs from the work item's name. */
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsString() @MaxLength(40) uom?: string;
  @IsNumber() @Min(0) qty!: number;
  /**
   * CRM Step 4. Normally omitted: the server fetches the cost itself (last accepted
   * receipt / approved order / catalogue). A value that differs from the fetched
   * one is a manual change and needs `costOverrideReason`.
   */
  @IsOptional() @IsNumber() @Min(0) unitCost?: number;
  @IsOptional() @IsString() costOverrideReason?: string;
  /** The SELLING price per unit. Omitted → cost plus the margin (not available to a caller without finance.costs.view). */
  @IsOptional() @IsNumber() @Min(0) unitPrice?: number;
  @IsOptional() @IsBoolean() isAdder?: boolean;
}

export class DesignVersionInputDto {
  @IsOptional() @IsString() sourceTool?: string;
  @IsOptional() @IsString() externalRef?: string;
  @IsOptional() @IsNumber() @Min(0) capacityKwp?: number;
  @IsOptional() @IsNumber() @Min(0) expectedAnnualKwh?: number;
}

export class CreateRevisionDto {
  /** The last day the offer is valid (ISO date). Default: today plus the configured validity days; must be after today. */
  @IsOptional() @IsString() validUntil?: string;
  @IsOptional() @IsString() pricingSchemeId?: string;
  @IsOptional() @IsNumber() @Min(0) marginPct?: number;
  /**
   * Package 3 · P3-4. PER_LINE (default, the old behaviour): every line carries its
   * selling price. LUMP_SUM: the lines carry cost only and `sellingTotal` is the price.
   */
  @IsOptional() @IsEnum(PRICING_MODES) pricingMode?: (typeof PRICING_MODES)[number];
  /** LUMP_SUM only: the budget's selling price (before VAT). Needed to submit, not to save a draft. */
  @IsOptional() @IsNumber() @Min(0) sellingTotal?: number;
  /** Risk contingency on the estimated cost, in percent (cost data). */
  @IsOptional() @IsNumber() @Min(0) @Max(100) contingencyPct?: number;
  /** The risks behind the contingency, for the general manager (cost data). */
  @IsOptional() @IsString() @MaxLength(4000) riskNotes?: string;
  @IsOptional() @ValidateNested() @Type(() => DesignVersionInputDto)
  designVersion?: DesignVersionInputDto;
  @IsArray() @ValidateNested({ each: true }) @Type(() => BomLineDto)
  bomLines!: BomLineDto[];
}

export class RejectProposalDto {
  /** Why the customer refused — mandatory, it becomes the history comment. */
  @IsString() reason!: string;
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

// ─── Work items (Package 3 · P3-3, ADR-03 §4-3) ─────────────────────────
export class CreateWorkItemDto {
  @IsString() @MinLength(1) @MaxLength(40) code!: string;
  @IsString() @MinLength(1) @MaxLength(200) nameAr!: string;
  @IsString() @MinLength(1) @MaxLength(200) nameEn!: string;
  @IsEnum(WORK_ITEM_KINDS) kind!: (typeof WORK_ITEM_KINDS)[number];
  @IsOptional() @IsString() @MaxLength(40) uom?: string;
  /** A cost figure: setting it needs finance.costs.view, like Item.unitCost. */
  @IsOptional() @IsNumber() @Min(0) defaultUnitCost?: number;
  /** Only for a MATERIAL work item: the stock item it stands for. */
  @IsOptional() @IsString() itemId?: string;
  @IsOptional() @IsInt() @Min(0) sortOrder?: number;
}

export class UpdateWorkItemDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) nameAr?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) nameEn?: string;
  @IsOptional() @IsEnum(WORK_ITEM_KINDS) kind?: (typeof WORK_ITEM_KINDS)[number];
  @IsOptional() @IsString() @MaxLength(40) uom?: string;
  @IsOptional() @IsNumber() @Min(0) defaultUnitCost?: number;
  /** null unlinks the stock item. */
  @IsOptional() @IsString() itemId?: string | null;
  @IsOptional() @IsInt() @Min(0) sortOrder?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}
