import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
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
}

// Rename and/or reorder a location (system rows may be renamed but not deleted).
export class UpdateLocationDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) name?: string;
  @IsOptional() @IsInt() sortOrder?: number;
}

// Set sort_order for a store's locations by the given order.
export class ReorderLocationsDto {
  @IsInt() @IsPositive() storeId!: number;
  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  orderedIds!: number[];
}
