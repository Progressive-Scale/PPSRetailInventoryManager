import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PaginationQuery } from '../../common/pagination';

export class OpenCycleCountDto {
  // Required for COMPANY_ADMIN; ignored for STORE_USER (uses their store).
  @IsOptional() @IsInt() @IsPositive() storeId?: number;

  /**
   * THE SCOPE OF THE COUNT, and therefore of the missing-stock sweep.
   *
   * Omit it and you get a whole-store count — which is what an older scanner build
   * sends, so its behaviour is unchanged. Provide it and only that location is
   * counted: units elsewhere in the store are untouched, and cannot be inferred
   * sold by a count that never went near them.
   */
  @IsOptional() @IsInt() @IsPositive() locationId?: number;

  /**
   * Narrow further to specific products ("count just the caps in the Backroom").
   * Empty/omitted means every product in the location.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsInt({ each: true })
  @IsPositive({ each: true })
  productIds?: number[];
}

// A physical count of a QUANTITY product. Identify by productId or upc.
// locationId defaults to the count's own location (or the Backroom for a
// whole-store count), so the scanner need not send it.
export class QuantityCountDto {
  @IsOptional() @IsInt() @IsPositive() productId?: number;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(128) upc?: string;
  @IsOptional() @IsInt() @IsPositive() locationId?: number;
  @IsInt() @Min(0) countedQuantity!: number;
}

/**
 * Something scanned that the catalog does not know.
 *
 * isUpc=true  -> quantity stock; still creates a needs-review PRODUCT, because a
 *                UPC identifies a product even when we lack its details.
 * isUpc=false -> a serialized unit with NO product at all. A serial identifies one
 *                physical thing and says nothing about what it is, so inventing a
 *                placeholder product per serial would pollute the catalog. The unit
 *                is created needs-review and product-less until somebody (or the
 *                PPS import agent) identifies it.
 */
export class NewItemDto {
  @IsString() @MinLength(1) @MaxLength(128) serialOrUpc!: string;

  /**
   * Optional for a serial: whoever scanned an unrecognised serial often cannot name
   * it, which is the whole reason for the import check. Still expected for a UPC,
   * where it becomes the product's name.
   */
  @IsOptional() @IsString() @MinLength(1) @MaxLength(256) name?: string;

  @IsBoolean() isUpc!: boolean;
  @IsOptional() @IsInt() @IsPositive() quantity?: number;
  @IsOptional() @IsISO8601() expirationDate?: string;
}

/**
 * What the counter hands in. Nothing here is applied on submit — it is turned into
 * proposed lines for an admin to approve.
 */
export class SubmitCycleCountDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  scannedSerials?: string[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => QuantityCountDto)
  quantityCounts?: QuantityCountDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => NewItemDto)
  newItems?: NewItemDto[];

  /**
   * Serials of SOLD units the counter found on the shelf and chose to put back.
   * A decision, not an inference — a sold unit reappearing could equally be a
   * return, a mis-scan or a wrong barcode, so the person holding it decides.
   */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  reinstateSerials?: string[];

  /**
   * Unknown serials the counter wants the PPS import agent to look up, rather than
   * naming by hand. Applied as import_check_status = REQUESTED on the created unit.
   */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  importCheckSerials?: string[];
}

/** Kept as the old name so existing imports/clients keep compiling. */
export class CloseCycleCountDto extends SubmitCycleCountDto {}

const CYCLE_COUNT_STATUSES = [
  'OPEN',
  'AWAITING_REVIEW',
  'CLOSED',
  'CANCELLED',
] as const;

/** Columns the cycle-count list may be ordered by. Whitelisted, not free text. */
export const CYCLE_COUNT_SORT_FIELDS = [
  'id',
  'status',
  'openedAt',
  'expectedCount',
  'scannedCount',
  'soldGeneratedCount',
] as const;
export type CycleCountSortField = (typeof CYCLE_COUNT_SORT_FIELDS)[number];

export class ListCycleCountsQuery extends PaginationQuery {
  @IsOptional() @IsInt() @IsPositive() storeId?: number;

  // Filtered server-side because the list is paginated — narrowing only the
  // current page would report a total that does not match what is shown.
  @IsOptional()
  @IsEnum(CYCLE_COUNT_STATUSES as unknown as string[])
  status?: (typeof CYCLE_COUNT_STATUSES)[number];

  // Sorted server-side for the same reason: reordering the twenty rows that happen to be
  // on this page would claim to sort the table while sorting a slice of it.
  @IsOptional()
  @IsEnum(CYCLE_COUNT_SORT_FIELDS as unknown as string[])
  sortBy?: CycleCountSortField;

  @IsOptional() @IsEnum(['asc', 'desc']) sortDir?: 'asc' | 'desc';
}

export class RejectCycleCountDto {
  /** Why it was sent back, shown to whoever recounts. */
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}
