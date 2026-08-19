import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsPositive,
} from 'class-validator';

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
   * COMPANY_ADMIN may name a store, or omit it for every store. A store-scoped user's
   * own store always wins — sending someone else's is not an error, it is ignored,
   * because the scope comes from the token and not from the request.
   */
  @IsOptional() @Type(() => Number) @IsInt() @IsPositive() storeId?: number;

  /**
   * The primary filter in practice. The legacy reports were run per cooler — the
   * samples are titled after one — so this is the field people actually reach for.
   */
  @IsOptional() @Type(() => Number) @IsInt() @IsPositive() locationId?: number;

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
  storeName: string | null;
  locationName: string | null;
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

export interface SummaryReport {
  meta: ReportMeta;
  rows: SummaryRow[];
  totals: ReportTotals;
}

export interface DetailReport {
  meta: ReportMeta;
  groups: DetailGroup[];
  totals: ReportTotals;
}

export type AnyReport = SummaryReport | DetailReport;
