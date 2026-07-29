import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/** Payment receipt against an invoice (W7). Validated at the pipe so a bad
 *  amount never reaches the journal-posting transaction. */
export class AddPaymentDto {
  @IsNumber() @IsPositive() amount!: number;

  @IsOptional()
  @IsIn(['BANK_TRANSFER', 'CHEQUE', 'CASH'])
  method?: 'BANK_TRANSFER' | 'CHEQUE' | 'CASH';

  @IsOptional() @IsString() @MaxLength(200) reference?: string;
}

/** One open payable settled by a vendor payment. */
export class PayAllocationDto {
  @IsIn(['BILL', 'CLAIM']) kind!: 'BILL' | 'CLAIM';

  @IsString() documentId!: string;

  @IsNumber() @IsPositive() amount!: number;
}

/** A single payment to one vendor, spread over its open documents. */
export class PayVendorDto {
  @IsString() vendorId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => PayAllocationDto)
  allocations!: PayAllocationDto[];

  @IsOptional()
  @IsIn(['BANK_TRANSFER', 'CHEQUE', 'CASH'])
  method?: 'BANK_TRANSFER' | 'CHEQUE' | 'CASH';

  @IsOptional() @IsString() @MaxLength(200) reference?: string;

  @IsOptional() @IsString() @MaxLength(500) memo?: string;
}

/** Credit note against a reported invoice. Omit `amount` to credit in full. */
export class CreateCreditNoteDto {
  @IsString() @MaxLength(300) reason!: string;

  @IsOptional() @IsNumber() @IsPositive() amount?: number;
}

/** Opens a calendar fiscal year and its twelve periods. */
export class OpenYearDto {
  @IsInt() @Min(2000) @Max(2100) year!: number;
}
