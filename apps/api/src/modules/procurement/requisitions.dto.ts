import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class RequisitionLineDto {
  @IsString() itemId!: string;
  @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) qty!: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) estimatedUnitPrice?: number;
  @IsOptional() @IsString() wbsElementId?: string;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class CreateRequisitionDto {
  /**
   * Required, not optional. A requisition is a request for the company's money;
   * "why" is the first thing an approver and an auditor both ask, and making it
   * optional guarantees the answer is missing on exactly the ones that matter.
   */
  @IsString() @MinLength(3) @MaxLength(1000) justification!: string;

  @IsOptional() @IsString() departmentId?: string;
  @IsOptional() @IsString() projectId?: string;
  @IsOptional() @IsDateString() neededBy?: string;
  @IsOptional() @IsString() currency?: string;

  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => RequisitionLineDto)
  lines!: RequisitionLineDto[];
}

export class UpdateRequisitionDto {
  @IsOptional() @IsString() @MinLength(3) @MaxLength(1000) justification?: string;
  @IsOptional() @IsString() departmentId?: string | null;
  @IsOptional() @IsString() projectId?: string | null;
  @IsOptional() @IsDateString() neededBy?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => RequisitionLineDto)
  lines?: RequisitionLineDto[];
}

/**
 * Every user-driven state change goes through one shape. The engine decides
 * whether the action is legal from `wf_transitions`, so this DTO does not
 * enumerate action codes — a flow gaining a transition must not require an
 * API deploy to become reachable.
 */
export class WorkflowActionDto {
  @IsString() @MinLength(1) @MaxLength(40) action!: string;
  @IsOptional() @IsString() @MaxLength(1000) comment?: string;
}

export class ConvertToPoDto {
  @IsString() vendorId!: string;
  @IsOptional() @IsString() currency?: string;
  /**
   * Real prices, if they differ from the estimates. Keyed by requisition line
   * id; a line not named here keeps its estimate.
   */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ConvertLinePriceDto)
  prices?: ConvertLinePriceDto[];
}

export class ConvertLinePriceDto {
  @IsString() requisitionLineId!: string;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) unitPrice!: number;
}
