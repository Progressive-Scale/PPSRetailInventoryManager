import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class ListLocationsQuery {
  // Required for COMPANY_ADMIN; ignored for STORE_USER (uses their store).
  @IsOptional() @Type(() => Number) @IsInt() @IsPositive() storeId?: number;
}

// Create a CUSTOM location. System locations (Backroom/On Floor) are not
// created here — they are created with the store.
export class CreateLocationDto {
  @IsInt() @IsPositive() storeId!: number;
  @IsString() @MinLength(1) @MaxLength(80) name!: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

// Edit a location: rename, reorder, or toggle active. System locations may be
// renamed but NOT deactivated (a store always needs its Backroom / On Floor).
export class UpdateLocationDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) name?: string;
  @IsOptional() @IsInt() sortOrder?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

// Set sort_order for a store's locations by the given order.
export class ReorderLocationsDto {
  @IsInt() @IsPositive() storeId!: number;
  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  orderedIds!: number[];
}
