import {
  IsEmail,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  MinLength,
} from 'class-validator';

// Enum value unions kept local to avoid importing Prisma enums into DTO
// metadata (they validate fine as plain string unions with class-validator).
const CUSTOMER_TYPES = ['RESIDENTIAL', 'CI', 'UTILITY', 'GOVERNMENT'] as const;
const LEAD_SOURCES = ['WEBSITE', 'REFERRAL', 'CAMPAIGN', 'DIRECT', 'WHATSAPP', 'OTHER'] as const;
const LEAD_STATUSES = ['NEW', 'QUALIFIED', 'DISQUALIFIED', 'CONVERTED'] as const;
const OPPORTUNITY_STAGES = ['PROSPECTING', 'PROPOSAL', 'NEGOTIATION', 'WON', 'LOST'] as const;

export class CreateCustomerDto {
  @IsString() @MinLength(1) nameAr!: string;
  @IsString() @MinLength(1) nameEn!: string;
  @IsOptional() @IsEnum(CUSTOMER_TYPES) customerType?: (typeof CUSTOMER_TYPES)[number];
  @IsOptional() @IsString() vatNumber?: string;
  @IsOptional() @IsString() crNumber?: string;
  @IsOptional() @IsInt() @Min(0) creditTermsDays?: number;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsEmail() email?: string;
}

export class UpdateCustomerDto {
  @IsOptional() @IsString() nameAr?: string;
  @IsOptional() @IsString() nameEn?: string;
  @IsOptional() @IsEnum(CUSTOMER_TYPES) customerType?: (typeof CUSTOMER_TYPES)[number];
  @IsOptional() @IsString() vatNumber?: string;
  @IsOptional() @IsString() crNumber?: string;
  @IsOptional() @IsInt() @Min(0) creditTermsDays?: number;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsEmail() email?: string;
}

export class CreateLeadDto {
  @IsString() @MinLength(1) contactName!: string;
  @IsOptional() @IsString() companyName?: string;
  @IsOptional() @IsEnum(LEAD_SOURCES) source?: (typeof LEAD_SOURCES)[number];
  @IsOptional() @IsNumber() estimatedKwp?: number;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsString() customerId?: string;
}

export class UpdateLeadDto {
  @IsOptional() @IsString() contactName?: string;
  @IsOptional() @IsString() companyName?: string;
  @IsOptional() @IsEnum(LEAD_SOURCES) source?: (typeof LEAD_SOURCES)[number];
  @IsOptional() @IsEnum(LEAD_STATUSES) status?: (typeof LEAD_STATUSES)[number];
  @IsOptional() @IsNumber() estimatedKwp?: number;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsString() customerId?: string;
}

export class ConvertLeadDto {
  // If the lead is not yet linked to a Customer, one is created from these.
  @IsOptional() @IsString() customerId?: string;
  @IsOptional() @IsString() opportunityName?: string;
  @IsOptional() @IsNumber() estimatedValue?: number;
}

export class CreateOpportunityDto {
  @IsString() @MinLength(1) name!: string;
  @IsString() customerId!: string;
  @IsOptional() @IsEnum(OPPORTUNITY_STAGES) stage?: (typeof OPPORTUNITY_STAGES)[number];
  @IsOptional() @IsNumber() estimatedKwp?: number;
  @IsOptional() @IsNumber() estimatedValue?: number;
  @IsOptional() @IsString() expectedCloseDate?: string;
}

export class UpdateOpportunityDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsEnum(OPPORTUNITY_STAGES) stage?: (typeof OPPORTUNITY_STAGES)[number];
  @IsOptional() @IsNumber() estimatedKwp?: number;
  @IsOptional() @IsNumber() estimatedValue?: number;
  @IsOptional() @IsString() expectedCloseDate?: string;
}
