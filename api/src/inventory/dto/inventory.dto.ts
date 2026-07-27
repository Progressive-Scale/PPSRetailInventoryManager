import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PaginationQuery } from '../../common/pagination';

// Product-level inventory listing (reads the store_inventory view).
export class ListInventoryQuery extends PaginationQuery {
  // COMPANY_ADMIN may narrow to a store within the company.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  storeId?: number;

  // Free-text: matches product name / sku / upc, or an individual serial.
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  search?: string;
}

// A sell/return/adjust action. Serialized products target a unit by `itemId`;
// quantity products target a `productId` + `quantity` (at a store).
export class InventoryActionDto {
  @IsOptional()
  @IsUUID()
  itemId?: string;

  @IsOptional()
  @IsInt()
  @IsPositive()
  productId?: number;

  @IsOptional()
  @IsInt()
  @IsPositive()
  quantity?: number;

  // Quantity moves: required for COMPANY_ADMIN, ignored for STORE_USER.
  @IsOptional()
  @IsInt()
  @IsPositive()
  storeId?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
