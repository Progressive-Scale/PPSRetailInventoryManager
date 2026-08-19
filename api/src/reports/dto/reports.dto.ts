import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsPositive,
} from 'class-validator';

/**
 * Query strings have no array type: one `storeIds` is a string, several is an array,
 * and a comma-separated list is one string holding many. All three are normalised
 * here so the rest of the code sees numbers.
 */
function toIdArray(value: unknown): number[] | undefined {
  if (value == null || value === '') return undefined;
  const raw = Array.isArray(value) ? value : [value];
  const out = raw
    .flatMap((v) => String(v).split(','))
    .map((v) => Number(v.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  return out.length ? [...new Set(out)] : undefined;
}

/**
 * Which report. Deliberately a closed list rather than a free-form "report name":
 * every one of these is a hand-written query with its own totals, and a report that
 * does not exist should fail at validation rather than as an empty page.
 */
export const REPORT_KINDS = ['SUMMARY', 'DETAIL', 'SOLD'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

/** How the caller wants it back. `json` renders on screen; the rest are downloads. */
export const REPORT_FORMATS = ['json', 'pdf', 'csv'] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

export class ReportQuery {
  /**
   * Which stores to cover. Omit for every store the caller can see.
   *
   * A store-scoped user's own store always wins — sending someone else's is not an
   * error, it is ignored, because the scope comes from the token and not from the
   * request.
   *
   * Accepts `storeIds=1&storeIds=3` or `storeIds=1,3`: a query string carrying one
   * value arrives as a scalar, and a report that silently covered one store when two
   * were asked for would be believed.
   */
  @IsOptional()
  @Transform(({ value }) => toIdArray(value))
  @IsArray()
  @ArrayMaxSize(50)
  @IsInt({ each: true })
  @IsPositive({ each: true })
  storeIds?: number[];

  /**
   * Which locations to cover, across whichever stores are in scope. Omit for all of
   * them.
   *
   * The primary filter in practice — the legacy reports were run per cooler and the
   * samples are titled after one — but several at once is the common ask, because a
   * cooler is rarely the whole question ("both coolers, not the sales floor").
   *
   * Same three shapes as `storeIds`. Locations outside the company are refused, not
   * ignored, for the same reason: a filter that quietly matched nothing would read
   * as an empty cooler.
   */
  @IsOptional()
  @Transform(({ value }) => toIdArray(value))
  @IsArray()
  @ArrayMaxSize(100)
  @IsInt({ each: true })
  @IsPositive({ each: true })
  locationIds?: number[];

  @IsOptional() @Type(() => Number) @IsInt() @IsPositive() productId?: number;

  /**
   * SOLD only, and both required for it: a sold report with no bounds would grow
   * without limit and mean nothing. Inclusive of both days in the company's own
   * reading — `to` is taken to the end of that date, so "the 1st to the 31st"
   * includes everything sold on the 31st.
   */
  @IsOptional() @IsISO8601() from?: string;

  @IsOptional() @IsISO8601() to?: string;
}

export class ReportRequestQuery extends ReportQuery {
  @IsOptional() @IsIn(REPORT_FORMATS) format?: ReportFormat;
}

/** A report's rows, before any particular rendering of them. */
export interface ReportMeta {
  kind: ReportKind;
  title: string;
  /** When it ran. The legacy calls this the Print Date. */
  generatedAt: string;
  companyName: string;
  /**
   * The stores this report covers, named. Empty means every store — which is not
   * the same as "no stores", and the header says so in words rather than printing
   * an empty list.
   */
  storeNames: string[];
  /** The locations covered, named. Empty means all of them, as with storeNames. */
  locationNames: string[];
  from: string | null;
  to: string | null;
}

export interface SummaryRow {
  productId: number;
  sku: string;
  name: string;
  trackingType: 'SERIALIZED' | 'QUANTITY';
  /** Null for quantity products: a shelf count has no weight. */
  weightLbs: number | null;
  /**
   * A unit with no case serial counts as its own case, which is why singletons come
   * out as "20 cases / 20 pieces" exactly as the legacy shows them. Null for
   * quantity products, which have no cases at all.
   */
  cases: number | null;
  pieces: number;
  avgWeightLbs: number | null;
  /** Value divided by weight — the analogue of the legacy's Cost/Unit at $/lb. */
  avgPricePerLb: number | null;
  value: number;
}

export interface DetailUnit {
  serial: string;
  caseSerial: string | null;
  weightLbs: number | null;
  locationName: string | null;
  receivedAt: string | null;
  soldAt: string | null;
  value: number;
  pricePerLb: number | null;
}

export interface DetailGroup {
  productId: number;
  sku: string;
  name: string;
  units: DetailUnit[];
  /**
   * weightLbs is null when NOTHING in the group was weighed — the same distinction
   * the rows themselves make. A subtotal of 0.00 lb over units that were never
   * weighed states a measurement that was never taken.
   */
  subtotal: { weightLbs: number | null; pieces: number; value: number };
}

export interface ReportTotals {
  /** Null when nothing anywhere in the report carried a weight. */
  weightLbs: number | null;
  cases: number;
  pieces: number;
  value: number;
}

/**
 * A report is a list of STORES, each with its own rows and its own subtotal.
 *
 * Grouping happens here rather than in each renderer: the screen, the PDF and the
 * CSV all need the same sections in the same order with the same subtotals, and
 * three implementations of that is three chances to disagree.
 */
export interface SummaryStoreSection {
  storeId: number;
  storeName: string;
  rows: SummaryRow[];
  subtotal: ReportTotals;
}

export interface DetailStoreSection {
  storeId: number;
  storeName: string;
  groups: DetailGroup[];
  subtotal: ReportTotals;
}

export interface SummaryReport {
  meta: ReportMeta;
  stores: SummaryStoreSection[];
  totals: ReportTotals;
}

export interface DetailReport {
  meta: ReportMeta;
  stores: DetailStoreSection[];
  totals: ReportTotals;
}

export type AnyReport = SummaryReport | DetailReport;
