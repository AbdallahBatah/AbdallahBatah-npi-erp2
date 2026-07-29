import { IsEnum, IsNumber, IsOptional, IsString, Min } from 'class-validator';

const BILLING_CYCLES = ['MONTHLY', 'QUARTERLY'] as const;

export class CreatePpaTermDto {
  /** Attach to an existing ACTIVE PPA/OM contract… */
  @IsOptional() @IsString() contractId?: string;
  /** …or create one inline for this customer. */
  @IsOptional() @IsString() customerId?: string;
  @IsString() projectId!: string;
  @IsNumber() @Min(0.0001) ratePerKwh!: number;
  @IsOptional() @IsNumber() @Min(0) escalationPctPerYear?: number;
  @IsOptional() @IsNumber() @Min(0) fixedMonthlyFee?: number;
  @IsOptional() @IsEnum(BILLING_CYCLES) billingCycle?: (typeof BILLING_CYCLES)[number];
  @IsOptional() @IsString() startDate?: string;
  @IsOptional() @IsString() endDate?: string;
}

export class SettleDto {
  @IsString() periodStart!: string;
  @IsString() periodEnd!: string;
}
