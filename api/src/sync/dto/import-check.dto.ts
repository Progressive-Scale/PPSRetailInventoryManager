import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsEnum,
  IsISO8601,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

const OUTCOMES = ['MATCHED', 'NOT_FOUND', 'DISCREPANCY'] as const;

/** The catalog facts PPS knows about a matched serial. ERP data is authoritative. */
export class ImportMatchDto {
  @IsString() @MinLength(1) @MaxLength(128) sku!: string;
  @IsString() @MinLength(1) @MaxLength(256) name!: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) price?: number;
  @IsOptional() @IsISO8601() expirationDate?: string;
  /** PPS's own identifier for the product, stored for traceability. */
  @IsOptional() @IsString() @MaxLength(128) ppsProductRef?: string;
}

/** Why PPS could not answer cleanly, and what it did see. */
export class ImportDiscrepancyDto {
  @IsString() @MinLength(1) @MaxLength(500) reason!: string;
  /** Free-form snapshot of what PPS holds, shown verbatim to an admin. */
  @IsOptional() @IsObject() ppsState?: Record<string, unknown>;
}

export class ImportCheckResultDto {
  @IsUUID() itemId!: string;

  @IsEnum(OUTCOMES as unknown as string[])
  outcome!: (typeof OUTCOMES)[number];

  /** Required when outcome is MATCHED. */
  @IsOptional()
  @ValidateNested()
  @Type(() => ImportMatchDto)
  match?: ImportMatchDto;

  /** Required when outcome is DISCREPANCY. */
  @IsOptional()
  @ValidateNested()
  @Type(() => ImportDiscrepancyDto)
  discrepancy?: ImportDiscrepancyDto;
}

export class ImportCheckResultsDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ImportCheckResultDto)
  results!: ImportCheckResultDto[];
}

export class ImportChecksQuery {
  @IsOptional() @Type(() => Number) @IsInt() @IsPositive() limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}
