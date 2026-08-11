import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsEnum,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export const HANDOFF_KINDS = ['unit', 'stock'] as const;
export type HandoffKind = (typeof HANDOFF_KINDS)[number];

/**
 * Floor a price at zero, leaving anything that is not a number alone so the
 * validators below still report it properly.
 */
export const clampToZero = ({ value }: { value: unknown }): unknown =>
  typeof value === 'number' && value < 0 ? 0 : value;

// A mixed handoff batch item. `kind` discriminates:
//   unit  -> serialized: requires `serial`
//   stock -> quantity:   requires `quantity` + `handoffId` (idempotency key)
// `kind` defaults to 'unit' when omitted (v1 compatibility).
export class HandoffItemDto {
  @IsOptional() @IsEnum(HANDOFF_KINDS as unknown as string[]) kind?: HandoffKind;

  @IsString() @MinLength(1) @MaxLength(128) sku!: string;
  @IsString() @MinLength(1) @MaxLength(256) name!: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  // A negative price is floored to 0 rather than rejected: an ERP credit line would
  // otherwise park the whole handoff as FAILED and need a human, and a unit that
  // cannot be sold for a negative amount is better described as costing nothing.
  // Floored before validation, so @Min(0) below only ever guards a non-number.
  @IsOptional()
  @Transform(clampToZero)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  price?: number;
  @IsOptional() @IsString() @MaxLength(128) upc?: string;
  // The cloud store id (stores.id) within the company this line routes to.
  @IsInt() @IsPositive() storeId!: number;

  // --- unit only ---
  // The SERIAL alone — the GS1 AI (21) value, e.g. '100000000462'. NOT the whole
  // barcode: this is the string a store scans and the identity key for the unit.
  @IsOptional() @IsString() @MinLength(1) @MaxLength(128) serial?: string;
  // The full GS1-128 barcode from the label, if the ERP has one. Optional and purely
  // additive — it is kept for traceability and matched as a fallback on scan, never
  // used as the identity key.
  @IsOptional() @IsString() @MinLength(1) @MaxLength(400) barcode?: string;
  @IsOptional() @IsISO8601() expirationDate?: string;
  /**
   * This unit's weight in POUNDS (random-weight goods). Not validated as positive:
   * gs1_item.weight_lbs really does hold negative values for credits and corrections,
   * and rejecting one would drop the handoff rather than record what the ERP says.
   */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 8 }) weightLbs?: number;

  // --- stock only ---
  @IsOptional() @IsInt() @IsPositive() quantity?: number;
  // Client-generated, unique per shipment line — the idempotency key.
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) handoffId?: string;
}

export class HandoffsDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => HandoffItemDto)
  handoffs!: HandoffItemDto[];
}

export class ReturnsAckDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  ids!: number[];
}
