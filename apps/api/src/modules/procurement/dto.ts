import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { SAUDI_VAT_OR_EMPTY_RE } from '@npi/shared';

const VENDOR_TYPES = ['SUPPLIER', 'SUBCONTRACTOR', 'OEM', 'SERVICE'] as const;

// ─── Vendors ──────────────────────────────────────────────────────────────
export class CreateVendorDto {
  @IsString() @MinLength(1) nameAr!: string;
  @IsString() @MinLength(1) nameEn!: string;
  @IsOptional() @IsEnum(VENDOR_TYPES) vendorType?: (typeof VENDOR_TYPES)[number];
  @IsOptional()
  @Matches(SAUDI_VAT_OR_EMPTY_RE, {
    message: 'vatNumber must be a Saudi VAT number (15 digits starting and ending with 3)',
  })
  vatNumber?: string;
  @IsOptional() @IsString() crNumber?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() email?: string;
  @IsOptional() @IsBoolean() isManufacturer?: boolean;
}

// ─── Purchase orders ──────────────────────────────────────────────────────
export class PoLineDto {
  @IsString() itemId!: string;
  @IsNumber() @Min(0.001) qty!: number;
  @IsNumber() @Min(0) unitPrice!: number;
  @IsOptional() @IsString() wbsElementId?: string;
}

export class CreatePoDto {
  @IsString() vendorId!: string;
  @IsOptional() @IsString() projectId?: string;
  @IsOptional() @IsString() currency?: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => PoLineDto)
  lines!: PoLineDto[];
}

// ─── Goods receipt ────────────────────────────────────────────────────────
export class ReceiveLineDto {
  @IsString() poLineId!: string;
  @IsNumber() @Min(0.001) qty!: number;
  /** Serial numbers — required (count === qty) when the item is serialised. */
  @IsOptional() @IsArray() @IsString({ each: true }) serials?: string[];
  @IsOptional() @IsString() batchNo?: string;
}

export class ReceiveDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => ReceiveLineDto)
  lines!: ReceiveLineDto[];
  @IsOptional() @IsString() notes?: string;
  /** SCM-04: where the goods land. Defaults to the first warehouse. */
  @IsOptional() @IsString() locationId?: string;
}

// ─── Vendor bill ──────────────────────────────────────────────────────────
export class CreateBillDto {
  @IsString() goodsReceiptId!: string;
  @IsOptional() @IsString() vendorRef?: string;
}

// ─── Subcontracts (PRJ-07) ────────────────────────────────────────────────
export class CreateSubcontractDto {
  @IsString() vendorId!: string;
  @IsString() projectId!: string;
  @IsOptional() @IsString() wbsElementId?: string;
  @IsString() @MinLength(1) scopeAr!: string;
  @IsString() @MinLength(1) scopeEn!: string;
  @IsNumber() @Min(0) amount!: number;
  @IsOptional() @IsNumber() @Min(0) retentionPct?: number;
}

export class CreateClaimDto {
  @IsNumber() @Min(0.01) claimedAmount!: number;
  @IsOptional() @IsString() descriptionAr?: string;
  @IsOptional() @IsString() descriptionEn?: string;
}

// ─── Stock transfers (SCM-04) ─────────────────────────────────────────────
export class TransferDto {
  /** Either a serial unit… */
  @IsOptional() @IsString() serialUnitId?: string;
  /** …or bulk qty of an item. */
  @IsOptional() @IsString() itemId?: string;
  @IsOptional() @IsNumber() @Min(0.001) qty?: number;
  @IsOptional() @IsString() fromLocationId?: string;
  @IsString() toLocationId!: string;
}
