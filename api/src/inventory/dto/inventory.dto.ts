import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBooleanString,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
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

// A sell/return/adjust action. Serialized products target a unit by `itemId`
// (the unit's own location is used); quantity products target a `productId` +
// `quantity` at a specific `locationId`.
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

  // Quantity moves: which location the stock leaves from (required for quantity).
  @IsOptional()
  @IsInt()
  @IsPositive()
  locationId?: number;

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

// Move inventory between locations. Two mutually-exclusive modes:
//   serialized — `itemIds` (each unit moves to `toLocationId`)
//   quantity   — `productId` + `fromLocationId` + `quantity` -> `toLocationId`
export class MoveInventoryDto {
  @IsInt()
  @IsPositive()
  toLocationId!: number;

  // Serialized mode.
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('4', { each: true })
  itemIds?: string[];

  // Quantity mode.
  @IsOptional()
  @IsInt()
  @IsPositive()
  productId?: number;

  @IsOptional()
  @IsInt()
  @IsPositive()
  fromLocationId?: number;

  @IsOptional()
  @IsInt()
  @IsPositive()
  quantity?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

const STOCK_SORT_FIELDS = [
  'sku',
  'barcode',
  'name',
  'type',
  'store',
  'onHand',
  'location',
  'expiration',
  'created',
] as const;

// Combined flat stock listing: one row per serialized unit + one row per
// quantity stock-location. Powers the portal's unified Stock grid.
export class ListStockQuery extends PaginationQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  storeId?: number;

  // Matches product name / sku / upc / serial.
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  locationId?: number;

  @IsOptional()
  @IsIn(['SERIALIZED', 'QUANTITY'])
  type?: 'SERIALIZED' | 'QUANTITY';

  // Serialized status scope: ON_HAND (default), SOLD, or ALL. Quantity rows are
  // included except when scoped to SOLD (they have no sold state).
  @IsOptional()
  @IsIn(['ON_HAND', 'SOLD', 'ALL'])
  status?: 'ON_HAND' | 'SOLD' | 'ALL';

  // Create-date range (inclusive), YYYY-MM-DD.
  @IsOptional()
  @IsISO8601()
  createdFrom?: string;

  @IsOptional()
  @IsISO8601()
  createdTo?: string;

  @IsOptional()
  @IsIn(STOCK_SORT_FIELDS as unknown as string[])
  sortBy?: (typeof STOCK_SORT_FIELDS)[number];

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortDir?: 'asc' | 'desc';
}

// Admin edit of a serialized unit's mutable fields (data correction).
export class UpdateItemDto {
  // YYYY-MM-DD, or null to clear the expiration.
  @IsOptional()
  @ValidateIf((o: UpdateItemDto) => o.expirationDate !== null)
  @IsISO8601()
  expirationDate?: string | null;
}

// Bulk mark serialized items as sold.
export class BulkSellDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('4', { each: true })
  itemIds!: string[];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

// Admin bulk edit of serialized items' expiration date (null clears it).
export class BulkExpirationDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('4', { each: true })
  itemIds!: string[];

  @ValidateIf((o: BulkExpirationDto) => o.expirationDate !== null)
  @IsISO8601()
  expirationDate!: string | null;
}

// Admin set of a quantity product's on-hand at a specific location.
export class SetQuantityDto {
  @IsInt() @IsPositive() productId!: number;
  @IsInt() @IsPositive() locationId!: number;
  @IsOptional() @IsInt() @IsPositive() storeId?: number;
  @IsInt() @Min(0) quantity!: number;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

// Resolve a scanned barcode to a movable target. `serial` resolves an ON_HAND
// unit (+ its location); `upc` resolves a product (+ per-location stock for
// quantity products). Used by the scanner's Move-Items flow.
export class LookupQuery {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  serial?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  upc?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  storeId?: number;
}

// Unit-level listing for the "in stock by expiration" view. Serialized units
// only, with their location + expiration, sorted by expiration date.
export class ListItemsQuery extends PaginationQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  storeId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  locationId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  productId?: number;

  // Only units expiring on/before this calendar date (YYYY-MM-DD).
  @IsOptional()
  @IsISO8601()
  expiresBefore?: string;

  // Only units expiring within N days from today (convenience alt to expiresBefore).
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  expiringWithinDays?: number;

  // 'true' -> only units that have an expiration date set.
  @IsOptional()
  @IsBooleanString()
  hasExpiration?: string;
}
