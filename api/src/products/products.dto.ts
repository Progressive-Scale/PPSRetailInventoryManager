import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

const toBool = ({ value }: { value: unknown }) =>
  value === true || value === 'true';

export const TRACKING_TYPES = ['SERIALIZED', 'QUANTITY'] as const;
export type TrackingTypeDto = (typeof TRACKING_TYPES)[number];

export class CreateProductDto {
  @IsString() @MinLength(1) @MaxLength(128) sku!: string;
  @IsString() @MinLength(1) @MaxLength(256) name!: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) price?: number;
  @IsOptional() @IsString() @MaxLength(128) upc?: string;
  /**
   * The 5-digit code inside this product's in-store price label — digits 2-6 of a
   * `2{code5}{price5}{check}` barcode. Held apart from `upc` because prefix 2 is
   * ambiguous, and only the catalog can say which kind of code a scan meant.
   */
  @IsOptional()
  @IsString()
  @Matches(/^\d{5}$/, {
    message: 'priceEmbeddedCode must be exactly 5 digits (leading zeros count).',
  })
  priceEmbeddedCode?: string;
  // Immutable after creation.
  @IsEnum(TRACKING_TYPES as unknown as string[]) trackingType!: TrackingTypeDto;
}

export class UpdateProductDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(128) sku?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(256) name?: string;
  /** An explicit null, or a blank string, removes the description. */
  @IsOptional() @IsString() @MaxLength(2000) description?: string | null;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) price?: number;
  /**
   * An explicit null removes the barcode; omit to leave it alone. A blank string means the
   * same thing and is normalised to null — the column is unique per company where it is
   * NOT NULL, so a stored '' collides with every other cleared UPC.
   */
  @IsOptional() @IsString() @MaxLength(128) upc?: string | null;
  /** An explicit null (or blank) clears the price-label code; omit to leave it alone. */
  @IsOptional()
  @ValidateIf((_o, v) => v !== null && v !== '')
  @IsString()
  @Matches(/^\d{5}$/, {
    message: 'priceEmbeddedCode must be exactly 5 digits (leading zeros count).',
  })
  priceEmbeddedCode?: string | null;
  @IsOptional() @Transform(toBool) @IsBoolean() active?: boolean;
  // Clearing this completes a review; setting it back is allowed too.
  @IsOptional() @Transform(toBool) @IsBoolean() needsReview?: boolean;
  /**
   * Low-stock hint threshold. An explicit null clears it, which is why the type
   * admits null: the field has to distinguish "leave it alone" (absent) from "no
   * threshold" (null), and a plain optional number cannot.
   */
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsInt() @Min(0)
  reorderThreshold?: number | null;
  // Accepted but must match the existing value (tracking_type is immutable);
  // a mismatch is rejected by the controller.
  @IsOptional() @IsEnum(TRACKING_TYPES as unknown as string[])
  trackingType?: TrackingTypeDto;
}

export class ListProductsQuery {
  @IsOptional() @Transform(toBool) @IsBoolean() active?: boolean;
  // Review queue for products flagged by unknown scans/handoffs.
  @IsOptional() @Transform(toBool) @IsBoolean() needsReview?: boolean;
}
