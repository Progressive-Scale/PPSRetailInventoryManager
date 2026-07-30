import { Transform, Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class ListLocationsQuery {
  // Optional for COMPANY_ADMIN (omit for every store); ignored for STORE_USER.
  @IsOptional() @Type(() => Number) @IsInt() @IsPositive() storeId?: number;

  /**
   * Inactive locations are hidden by default, so scanners and move dialogs only
   * ever receive usable locations. The admin screen opts in to manage them.
   */
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  includeInactive?: boolean;
}

// Create a location of any kind. A store starts with one Backroom + one On Floor
// (created with the store) and may be given more of either. Kind defaults to
// CUSTOM and is immutable once created — there is deliberately no kind on update.
export class CreateLocationDto {
  @IsInt() @IsPositive() storeId!: number;
  @IsString() @MinLength(1) @MaxLength(80) name!: string;
  @IsOptional() @IsIn(['BACKROOM', 'ONFLOOR', 'CUSTOM'])
  kind?: 'BACKROOM' | 'ONFLOOR' | 'CUSTOM';
  @IsOptional() @IsBoolean() isActive?: boolean;
}

// Edit a location: rename, reorder, or toggle active. Deactivating goes through
// the same guards as POST :id/deactivate — live stock and the last-active-of-a-
// required-kind rule both block it.
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
