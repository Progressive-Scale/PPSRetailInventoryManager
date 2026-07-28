import { Type } from 'class-transformer';
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

// A mixed handoff batch item. `kind` discriminates:
//   unit  -> serialized: requires `serial`
//   stock -> quantity:   requires `quantity` + `handoffId` (idempotency key)
// `kind` defaults to 'unit' when omitted (v1 compatibility).
export class HandoffItemDto {
  @IsOptional() @IsEnum(HANDOFF_KINDS as unknown as string[]) kind?: HandoffKind;

  @IsString() @MinLength(1) @MaxLength(128) sku!: string;
  @IsString() @MinLength(1) @MaxLength(256) name!: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) price?: number;
  @IsOptional() @IsString() @MaxLength(128) upc?: string;
  // The cloud store id (stores.id) within the company this line routes to.
  @IsInt() @IsPositive() storeId!: number;

  // --- unit only ---
  @IsOptional() @IsString() @MinLength(1) @MaxLength(128) serial?: string;
  @IsOptional() @IsISO8601() expirationDate?: string;

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
