import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
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
  // Required for COMPANY_ADMIN; ignored for a store-scoped user (uses their store).
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
/** Which column a scanned code belongs in. A price label is NOT a UPC. */
export const CAPTURED_CODE_FIELDS = ['upc', 'price_embedded_code'] as const;
export type CapturedCodeField = (typeof CAPTURED_CODE_FIELDS)[number];

/** What a new product may be tracked as. */
export const NEW_ITEM_TRACKING = ['SERIALIZED', 'QUANTITY'] as const;

/**
 * The code that STARTED a new-product flow, and where it belongs.
 *
 * Which field is the SERVER's decision, not the scanner's: a leading-2 barcode may
 * be a catalog UPC or an in-store price label, and filing a price label's five
 * digits as a UPC would corrupt the very lookup this exists to serve — and make the
 * cross-field collision guard report conflicts that do not exist.
 */
export class CapturedCodeDto {
  @IsIn(CAPTURED_CODE_FIELDS as unknown as string[])
  field!: CapturedCodeField;

  @IsString() @MinLength(1) @MaxLength(128) value!: string;
}

export class NewItemDto {
  @IsString() @MinLength(1) @MaxLength(128) serialOrUpc!: string;

  /**
   * Optional for a serial: whoever scanned an unrecognised serial often cannot name
   * it, which is the whole reason for the import check. Still expected for a UPC,
   * where it becomes the product's name.
   */
  @IsOptional() @IsString() @MinLength(1) @MaxLength(256) name?: string;

  /**
   * LEGACY — the old "is this a UPC or a serial?" answer the app used to put to the
   * counter, and which this feature removes from the UI.
   *
   * Kept OPTIONAL rather than deleted because scanners update on their own schedule:
   * a handheld still on an older build submits this shape and its counts must keep
   * landing. New builds send `trackingType` + `capturedCode` instead and omit this.
   * Exactly one of the two shapes must be present — enforced in the service.
   *
   * @deprecated superseded by trackingType/capturedCode.
   */
  @IsOptional() @IsBoolean() isUpc?: boolean;

  /**
   * What the counter said this is — the ONLY question the new-product popup asks.
   * SERIALIZED additionally requires `serial`.
   */
  @IsOptional() @IsIn(NEW_ITEM_TRACKING as unknown as string[])
  trackingType?: (typeof NEW_ITEM_TRACKING)[number];

  /** The code that opened the flow, and the column it belongs in. */
  @IsOptional() @ValidateNested() @Type(() => CapturedCodeDto)
  capturedCode?: CapturedCodeDto;

  /**
   * The R-serial scanned AFTER the product was named. Required when trackingType is
   * SERIALIZED, meaningless otherwise.
   *
   * This field is what enforces the rule that a price barcode can never enter a
   * serialized unit: the code that opened the flow identifies a PRODUCT, and only a
   * real serial scan identifies the piece in somebody's hand.
   */
  @IsOptional() @IsString() @MinLength(1) @MaxLength(128) serial?: string;

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
   * Serials the counter says are NOT on the shelf — "I looked, it is gone".
   *
   * Without this, a product nobody scanned is reported NOT_COUNTED and left alone, which
   * is the right default: a count that never reached a shelf is not evidence its stock was
   * sold. But a counter who did walk the shelf and found it empty has no way to say so, and
   * the honest reading of that is a sale. This is the counter making that call explicitly,
   * one product at a time, rather than the sweep inferring it.
   *
   * Only in-scope, unaccounted units are honoured. A scan always wins: a unit that was
   * scanned is present, whatever this list says.
   */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  markSoldSerials?: string[];

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

  // Count number, store name, or the username of whoever opened, submitted or closed
  // it. Bounded because it reaches an ILIKE.
  @IsOptional() @IsString() @MaxLength(128) search?: string;
}

export class RejectCycleCountDto {
  /** Why it was sent back, shown to whoever recounts. */
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}
