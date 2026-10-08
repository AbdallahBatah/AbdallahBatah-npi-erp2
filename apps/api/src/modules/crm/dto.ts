import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { SAUDI_VAT_OR_EMPTY_RE } from '@npi/shared';

const VAT_MESSAGE = {
  message: 'vatNumber must be a Saudi VAT number (15 digits starting and ending with 3)',
};

// Enum value unions kept local to avoid importing Prisma enums into DTO
// metadata (they validate fine as plain string unions with class-validator).
const CUSTOMER_TYPES = ['RESIDENTIAL', 'CI', 'UTILITY', 'GOVERNMENT'] as const;
const CUSTOMER_ENTITY_KINDS = ['COMPANY', 'INDIVIDUAL'] as const;
const LEAD_SOURCES = ['WEBSITE', 'REFERRAL', 'CAMPAIGN', 'DIRECT', 'WHATSAPP', 'OTHER'] as const;
const LEAD_STATUSES = ['NEW', 'QUALIFIED', 'DISQUALIFIED', 'CONVERTED'] as const;
const OPPORTUNITY_STAGES = ['PROSPECTING', 'QUALIFICATION', 'PROPOSAL', 'NEGOTIATION', 'WON', 'LOST'] as const;
const OPPORTUNITY_TYPES = ['DIRECT', 'TENDER'] as const;

export class CreateCustomerDto {
  @IsString() @MinLength(1) nameAr!: string;
  @IsString() @MinLength(1) nameEn!: string;
  @IsOptional() @IsEnum(CUSTOMER_TYPES) customerType?: (typeof CUSTOMER_TYPES)[number];
  /** COMPANY (default) needs a CR or VAT number; INDIVIDUAL needs a mobile. */
  @IsOptional() @IsEnum(CUSTOMER_ENTITY_KINDS) entityKind?: (typeof CUSTOMER_ENTITY_KINDS)[number];
  /** Saudi mobile (05xxxxxxxx / +9665xxxxxxxx …); stored as +9665xxxxxxxx. */
  @IsOptional() @IsString() mobile?: string;
  @IsOptional() @Matches(SAUDI_VAT_OR_EMPTY_RE, VAT_MESSAGE) vatNumber?: string;
  @IsOptional() @IsString() crNumber?: string;
  @IsOptional() @IsInt() @Min(0) creditTermsDays?: number;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsEmail() email?: string;
}

export class UpdateCustomerDto {
  @IsOptional() @IsString() nameAr?: string;
  @IsOptional() @IsString() nameEn?: string;
  @IsOptional() @IsEnum(CUSTOMER_TYPES) customerType?: (typeof CUSTOMER_TYPES)[number];
  @IsOptional() @IsEnum(CUSTOMER_ENTITY_KINDS) entityKind?: (typeof CUSTOMER_ENTITY_KINDS)[number];
  @IsOptional() @IsString() mobile?: string;
  @IsOptional() @Matches(SAUDI_VAT_OR_EMPTY_RE, VAT_MESSAGE) vatNumber?: string;
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
  // Keys for the customer created from the lead (checked for duplicates).
  @IsOptional() @IsString() crNumber?: string;
  @IsOptional() @Matches(SAUDI_VAT_OR_EMPTY_RE, VAT_MESSAGE) vatNumber?: string;
  @IsOptional() @IsString() mobile?: string;
  @IsOptional() @IsString() opportunityName?: string;
  @IsOptional() @IsNumber() estimatedValue?: number;
  /** Step 3: a converted lead may start as a tender. Default DIRECT. */
  @IsOptional() @IsEnum(OPPORTUNITY_TYPES) opportunityType?: (typeof OPPORTUNITY_TYPES)[number];
  /** Mandatory when opportunityType is TENDER (the same rule as creating one by hand). */
  @IsOptional() @IsString() tenderCloseDate?: string;
}

/**
 * An opportunity is always born PROSPECTING: the stage is moved by
 * POST /opportunities/:id/stage (or by creating a proposal / a contract), never
 * by a field of the create body.
 *
 * Dates arrive as yyyy-mm-dd strings; the service validates them (a bad date is
 * a 400 there). The tender fields apply to opportunityType = TENDER only —
 * tenderCloseDate is then mandatory; for DIRECT they are ignored.
 */
export class CreateOpportunityDto {
  @IsString() @MinLength(1) name!: string;
  @IsString() customerId!: string;
  @IsOptional() @IsEnum(OPPORTUNITY_TYPES) opportunityType?: (typeof OPPORTUNITY_TYPES)[number];
  @IsOptional() @IsNumber() estimatedKwp?: number;
  @IsOptional() @IsNumber() estimatedValue?: number;
  @IsOptional() @IsString() expectedCloseDate?: string;
  @IsOptional() @IsString() tenderReference?: string;
  @IsOptional() @IsString() tenderCloseDate?: string;
  @IsOptional() @IsNumber() @Min(0) bidBondAmount?: number;
  @IsOptional() @IsString() bidBondBank?: string;
  @IsOptional() @IsString() bidBondExpiry?: string;
  @IsOptional() @IsString() bidBondReference?: string;
}

export class UpdateOpportunityDto {
  @IsOptional() @IsString() name?: string;
  /**
   * Declared ONLY so the service can answer a stage in a PATCH with the clear
   * 400 "Stage changes go through /stage" (the global pipe would otherwise say
   * "property stage should not exist"). It is never applied.
   */
  @IsOptional() @IsString() stage?: string;
  @IsOptional() @IsEnum(OPPORTUNITY_TYPES) opportunityType?: (typeof OPPORTUNITY_TYPES)[number];
  @IsOptional() @IsNumber() estimatedKwp?: number;
  @IsOptional() @IsNumber() estimatedValue?: number;
  @IsOptional() @IsString() expectedCloseDate?: string;
  @IsOptional() @IsString() tenderReference?: string;
  @IsOptional() @IsString() tenderCloseDate?: string;
  @IsOptional() @IsNumber() @Min(0) bidBondAmount?: number;
  @IsOptional() @IsString() bidBondBank?: string;
  @IsOptional() @IsString() bidBondExpiry?: string;
  @IsOptional() @IsString() bidBondReference?: string;
  /** The only fields besides `name` that a closed (WON / LOST) opportunity still accepts. */
  @IsOptional() @IsString() lossNotes?: string;
}

/** POST /opportunities/:id/stage. LOST needs `lossReasonId` (an active reason of the organization). */
export class ChangeStageDto {
  @IsEnum(OPPORTUNITY_STAGES) stage!: (typeof OPPORTUNITY_STAGES)[number];
  @IsOptional() @IsString() lossReasonId?: string;
  @IsOptional() @IsString() lossNotes?: string;
}

export class CreateLossReasonDto {
  @IsString() @MinLength(1) nameAr!: string;
  @IsString() @MinLength(1) nameEn!: string;
  @IsOptional() @IsInt() sortOrder?: number;
}

/** There is deliberately no way to delete a reason: switch it off with isActive = false. */
export class UpdateLossReasonDto {
  @IsOptional() @IsString() @MinLength(1) nameAr?: string;
  @IsOptional() @IsString() @MinLength(1) nameEn?: string;
  @IsOptional() @IsInt() sortOrder?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class CreateContactDto {
  @IsString() @MinLength(1) name!: string;
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() mobile?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsBoolean() isPrimary?: boolean;
  @IsOptional() @IsString() notes?: string;
}

export class UpdateContactDto {
  @IsOptional() @IsString() @MinLength(1) name?: string;
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() mobile?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsBoolean() isPrimary?: boolean;
  @IsOptional() @IsString() notes?: string;
}

export class MergeCustomersDto {
  @IsString() @MinLength(1) survivorId!: string;
  @IsArray() @ArrayNotEmpty() @ArrayMaxSize(50) @IsString({ each: true }) mergedIds!: string[];
  /** File name of the backup the administrator took before merging. */
  @IsString() @MinLength(8) backupRef!: string;
}

// ── CRM Phase 1 · Step 5: the communication log and the follow-up tasks ───────

const ACTIVITY_TYPES = ['NOTE', 'CALL', 'MEETING'] as const;

/**
 * The follow-up that may be created together with a log entry. The customer and the
 * opportunity are the entry's; the title defaults to the start of the entry's text.
 * Dates arrive as yyyy-mm-dd (or ISO) strings; the service validates them (a bad date
 * is a 400 there).
 */
export class ActivityFollowUpDto {
  @IsOptional() @IsString() @MaxLength(200) title?: string;
  @IsOptional() @IsString() @MaxLength(4000) details?: string;
  @IsString() dueAt!: string;
  @IsOptional() @IsString() remindAt?: string;
  @IsOptional() @IsString() assigneeId?: string;
}

export class CreateActivityDto {
  @IsString() @MinLength(1) customerId!: string;
  @IsOptional() @IsString() opportunityId?: string;
  @IsOptional() @IsString() contactId?: string;
  @IsOptional() @IsString() projectId?: string;
  @IsEnum(ACTIVITY_TYPES) activityType!: (typeof ACTIVITY_TYPES)[number];
  /** When it happened; default now; not more than 5 minutes ahead. */
  @IsOptional() @IsString() occurredAt?: string;
  @IsString() @MinLength(1) @MaxLength(4000) body!: string;
  @IsOptional() @ValidateNested() @Type(() => ActivityFollowUpDto) followUp?: ActivityFollowUpDto;
}

/** Only these fields of an entry change; its customer and opportunity never do. There is no delete. */
export class UpdateActivityDto {
  @IsOptional() @IsEnum(ACTIVITY_TYPES) activityType?: (typeof ACTIVITY_TYPES)[number];
  @IsOptional() @IsString() occurredAt?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(4000) body?: string;
  /** null clears the contact. */
  @IsOptional() @IsString() contactId?: string | null;
}

export class CreateTaskDto {
  @IsString() @MinLength(1) customerId!: string;
  @IsOptional() @IsString() opportunityId?: string;
  @IsOptional() @IsString() projectId?: string;
  @IsString() @MinLength(1) @MaxLength(200) title!: string;
  @IsOptional() @IsString() @MaxLength(4000) details?: string;
  @IsString() dueAt!: string;
  @IsOptional() @IsString() remindAt?: string;
  @IsOptional() @IsString() assigneeId?: string;
}

export class UpdateTaskDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) title?: string;
  @IsOptional() @IsString() @MaxLength(4000) details?: string;
  @IsOptional() @IsString() dueAt?: string;
  @IsOptional() @IsString() remindAt?: string;
  @IsOptional() @IsString() assigneeId?: string;
}

export class CancelTaskDto {
  /** Mandatory — the service answers a blank one with 400 "Cancellation reason is required". */
  @IsOptional() @IsString() @MaxLength(1000) reason?: string;
}
