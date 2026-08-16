import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { APPROVAL_DOCUMENTS, type ApprovalDocumentType } from '@npi/shared';

const DOCUMENT_TYPES = APPROVAL_DOCUMENTS.map((d) => d.value);

export class RuleStepDto {
  @IsString()
  roleId!: string;
}

export class CreateApprovalRuleDto {
  @IsIn(DOCUMENT_TYPES)
  documentType!: ApprovalDocumentType;

  /** Inclusive floor of the band. */
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  minAmount!: number;

  /** Exclusive ceiling; omit (or null) for "and above". */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  maxAmount?: number | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  /** Signature chain, in the order given — array position is the step number. */
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => RuleStepDto)
  steps!: RuleStepDto[];
}

export class UpdateApprovalRuleDto {
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  minAmount?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  maxAmount?: number | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => RuleStepDto)
  steps?: RuleStepDto[];
}

export class DecideDto {
  @IsIn(['APPROVE', 'REJECT'])
  decision!: 'APPROVE' | 'REJECT';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
