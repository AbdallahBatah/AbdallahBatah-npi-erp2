import { IsIn, IsNumber, IsOptional, IsPositive, IsString, MaxLength } from 'class-validator';

/** Payment receipt against an invoice (W7). Validated at the pipe so a bad
 *  amount never reaches the journal-posting transaction. */
export class AddPaymentDto {
  @IsNumber() @IsPositive() amount!: number;

  @IsOptional()
  @IsIn(['BANK_TRANSFER', 'CHEQUE', 'CASH'])
  method?: 'BANK_TRANSFER' | 'CHEQUE' | 'CASH';

  @IsOptional() @IsString() @MaxLength(200) reference?: string;
}
