import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

// ─── Package 6 (ADR-06) — المال الميداني ──────────────────────────────────

export class CreatePaymentRequestDto {
  @IsString() vendorId!: string;
  @IsIn(['ADVANCE', 'AGAINST_BILL']) kind!: 'ADVANCE' | 'AGAINST_BILL';
  /** Required for AGAINST_BILL: an approved bill of this vendor. */
  @IsOptional() @IsString() vendorBillId?: string;
  @IsOptional() @IsString() purchaseOrderId?: string;
  @IsOptional() @IsString() projectId?: string;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) amount!: number;
  @IsString() @MinLength(5) @MaxLength(1000) reason!: string;
}

export class PayRequestDto {
  @IsOptional() @IsIn(['BANK_TRANSFER', 'CHEQUE', 'CASH']) method?: 'BANK_TRANSFER' | 'CHEQUE' | 'CASH';
  @IsOptional() @IsString() @MaxLength(120) reference?: string;
}

export class CreateCustodyDto {
  @IsString() custodianId!: string;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

export class CashAmountDto {
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) amount!: number;
  @IsOptional() @IsString() @MaxLength(500) memo?: string;
}

export class SettlementLineDto {
  @IsString() projectId!: string;
  @IsOptional() @IsString() wbsElementId?: string;
  @IsString() @MinLength(2) @MaxLength(300) description!: string;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) amount!: number;
  @IsDateString() spentOn!: string;
}

export class CreateSettlementDto {
  @IsOptional() @IsString() @MaxLength(500) memo?: string;
  @IsArray() @ArrayNotEmpty() @ValidateNested({ each: true }) @Type(() => SettlementLineDto)
  lines!: SettlementLineDto[];
}
