import { clampToZero } from './sync.dto';
import { Transform, Type } from 'class-transformer';
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
  // Floored at zero for the reason given on the handoff's price.
  @IsOptional()
  @Transform(clampToZero)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  price?: number;
  @IsOptional() @IsISO8601() expirationDate?: string;
  /**
   * This unit's weight in POUNDS, if PPS knows it. Unit-level, unlike most of this
   * payload: sku/name/price/description describe the PRODUCT, while this and the
   * expiration describe the one physical thing that was scanned. No unsigned check —
   * see HandoffItemDto.weightLbs for why.
   */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 8 }) weightLbs?: number;
  /** PPS's own identifier for the product, stored for traceability. */
  @IsOptional() @IsString() @MaxLength(128) ppsProductRef?: string;
  /**
   * The full GS1-128 barcode from the label. A unit created from an unknown scan has no
   * barcode — the store sent only a serial — so a match is the first chance to record it.
   */
  @IsOptional() @IsString() @MinLength(1) @MaxLength(400) barcode?: string;
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
