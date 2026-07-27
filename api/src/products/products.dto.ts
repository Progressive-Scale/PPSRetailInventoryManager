import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
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
  // Immutable after creation.
  @IsEnum(TRACKING_TYPES as unknown as string[]) trackingType!: TrackingTypeDto;
}

export class UpdateProductDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(128) sku?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(256) name?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) price?: number;
  @IsOptional() @IsString() @MaxLength(128) upc?: string;
  @IsOptional() @Transform(toBool) @IsBoolean() active?: boolean;
  // Clearing this completes a review; setting it back is allowed too.
  @IsOptional() @Transform(toBool) @IsBoolean() needsReview?: boolean;
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
