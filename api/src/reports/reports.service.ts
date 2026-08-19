import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, gte, inArray, lte, SQL, sql } from 'drizzle-orm';
import { DataContext, isStoreScoped } from '../auth/auth.types';
import { TenantDbService, Tx } from '../db/tenant-db.service';
import { AuditService } from '../audit/audit.service';
import { MailService } from '../mail/mail.service';
import { MailAttachment, MailResult } from '../mail/mail.types';
import { fileName, toCsv, toPdf } from './report-render';
import { EmailReportDto } from './dto/email-report.dto';
import {
  companies,
  inventoryItems,
  inventoryStock,
  products,
  storeLocations,
  stores,
  users,
} from '../db/schema';
import {
  AnyReport,
  DetailGroup,
  DetailReport,
  DetailStoreSection,
  ReportKind,
  ReportMeta,
  ReportQuery,
  ReportTotals,
  SummaryReport,
  SummaryRow,
  SummaryStoreSection,
} from './dto/reports.dto';

/** numeric columns arrive as strings; a report that adds strings is a report of nonsense. */
function num(v: unknown): number {
  if (v == null) return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Money and weights are rounded once, at the edge, so totals match what is printed. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const EMPTY_TOTALS: ReportTotals = {
  weightLbs: null,
  cases: 0,
  pieces: 0,
  value: 0,
};

/**
 * Add up parts that each already know whether they carry a weight.
 *
 * `weightLbs` stays null unless something being added actually had one — the same
 * distinction the rows make. Zero is a measurement; absence is not. One function for
 * rows, store subtotals and the grand total, so all three agree by construction.
 */
function sumTotals(parts: ReportTotals[]): ReportTotals {
  if (parts.length === 0) return { ...EMPTY_TOTALS };
  const anyWeighed = parts.some((p) => p.weightLbs != null);
  const t = parts.reduce<{
    weightLbs: number;
    cases: number;
    pieces: number;
    value: number;
  }>(
    (acc, p) => ({
      weightLbs: round2(acc.weightLbs + (p.weightLbs ?? 0)),
      cases: acc.cases + p.cases,
      pieces: acc.pieces + p.pieces,
      value: round2(acc.value + p.value),
    }),
    { weightLbs: 0, cases: 0, pieces: 0, value: 0 },
  );
  return { ...t, weightLbs: anyWeighed ? t.weightLbs : null };
}

@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
  ) {}

  /** One report by kind, so the email path and the download path cannot diverge. */
  async build(ctx: DataContext, kind: ReportKind, q: ReportQuery): Promise<AnyReport> {
    if (kind === 'SUMMARY') return this.summary(ctx, q);
    if (kind === 'DETAIL') return this.detail(ctx, q);
    return this.sold(ctx, q);
  }

  /**
   * Which stores this report covers. An empty array means "every store".
   *
   * A store-scoped user gets their own and only their own: a manager cannot report on
   * a store they cannot otherwise see, and asking for one is ignored rather than
   * refused, because the scope is a property of the account and not of the request.
   */
  private readStoreIds(ctx: DataContext, requested?: number[]): number[] {
    if (isStoreScoped(ctx.role)) {
      if (ctx.storeId == null) {
        throw new BadRequestException(
          'Your account is not assigned to a store, so there is nothing to report on.',
        );
      }
      return [ctx.storeId];
    }
    return requested?.length ? requested : [];
  }

  async summary(ctx: DataContext, q: ReportQuery): Promise<SummaryReport> {
    const storeIds = this.readStoreIds(ctx, q.storeIds);
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      const known = await this.storeNames(tx, ctx, storeIds);
      const meta = await this.meta(tx, ctx, 'SUMMARY', known, q, storeIds);

      // Two passes rather than a UNION: the shapes measure different things — one has
      // weight and cases, the other has neither — and forcing them into one query
      // would only hide that.
      const rows = [
        ...(await this.summarySerialized(tx, ctx, storeIds, q)),
        ...(await this.summaryQuantity(tx, ctx, storeIds, q)),
      ];

      const sections: SummaryStoreSection[] = known.map(([storeId, storeName]) => {
        const mine = rows
          .filter((r) => r.storeId === storeId)
          .sort((a, b) => a.sku.localeCompare(b.sku));
        return {
          storeId,
          storeName,
          rows: mine.map(({ storeId: _drop, ...rest }) => rest),
          subtotal: sumTotals(
            mine.map((r) => ({
              weightLbs: r.weightLbs,
              cases: r.cases ?? 0,
              pieces: r.pieces,
              value: r.value,
            })),
          ),
        };
      });

      return {
        meta,
        stores: sections,
        totals: sumTotals(sections.map((s) => s.subtotal)),
      };
    });
  }

  async detail(ctx: DataContext, q: ReportQuery): Promise<DetailReport> {
    return this.unitReport(ctx, q, 'DETAIL');
  }

  /**
   * What left, between two dates.
   *
   * Serialized units only. A shelf sale leaves an inventory_transactions row carrying
   * a quantity and nothing else — no serial, no weight, and no price as it stood that
   * day — so it cannot honestly appear in a report whose columns are per piece. When
   * the ledger starts recording the price of a sale, this can grow a second section.
   */
  async sold(ctx: DataContext, q: ReportQuery): Promise<DetailReport> {
    if (!q.from || !q.to) {
      throw new BadRequestException(
        'The sold report needs a date range: give both a from and a to date.',
      );
    }
    if (q.from > q.to) {
      throw new BadRequestException('The from date is after the to date.');
    }
    return this.unitReport(ctx, q, 'SOLD');
  }

  private async unitReport(
    ctx: DataContext,
    q: ReportQuery,
    kind: 'DETAIL' | 'SOLD',
  ): Promise<DetailReport> {
    const storeIds = this.readStoreIds(ctx, q.storeIds);
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      const known = await this.storeNames(tx, ctx, storeIds);
      const meta = await this.meta(tx, ctx, kind, known, q, storeIds);
      const byStore = await this.unitGroups(
        tx,
        ctx,
        storeIds,
        q,
        kind === 'SOLD' ? 'SOLD' : 'ON_HAND',
      );

      const sections: DetailStoreSection[] = known.map(([storeId, storeName]) => {
        const groups = byStore.get(storeId) ?? [];
        return {
          storeId,
          storeName,
          groups,
          subtotal: sumTotals(
            groups.map((g) => ({
              weightLbs: g.subtotal.weightLbs,
              // Cases are a summary idea; these rows are pieces.
              cases: 0,
              pieces: g.subtotal.pieces,
              value: g.subtotal.value,
            })),
          ),
        };
      });

      return {
        meta,
        stores: sections,
        totals: sumTotals(sections.map((s) => s.subtotal)),
      };
    });
  }

  // ---- rows -------------------------------------------------------------

  private itemConds(
    ctx: DataContext,
    storeIds: number[],
    q: ReportQuery,
    status: 'ON_HAND' | 'SOLD',
  ): SQL[] {
    const conds: SQL[] = [
      eq(inventoryItems.companyId, ctx.companyId),
      eq(inventoryItems.status, status),
    ];
    if (storeIds.length) conds.push(inArray(inventoryItems.storeId, storeIds));
    if (q.locationId != null)
      conds.push(eq(inventoryItems.locationId, q.locationId));
    if (q.productId != null)
      conds.push(eq(inventoryItems.productId, q.productId));

    if (status === 'SOLD' && q.from && q.to) {
      // `to` is taken to the END of that day, so a range of the 1st to the 31st
      // includes a sale made at 4pm on the 31st. An exclusive bound here is the
      // classic way to silently lose the last day of a month.
      conds.push(gte(inventoryItems.soldAt, new Date(`${q.from}T00:00:00.000Z`)));
      conds.push(lte(inventoryItems.soldAt, new Date(`${q.to}T23:59:59.999Z`)));
    }
    return conds;
  }

  private async summarySerialized(
    tx: Tx,
    ctx: DataContext,
    storeIds: number[],
    q: ReportQuery,
  ): Promise<(SummaryRow & { storeId: number })[]> {
    const rows = await tx
      .select({
        storeId: inventoryItems.storeId,
        productId: products.id,
        sku: products.sku,
        name: products.name,
        weight: sql<string>`coalesce(sum(${inventoryItems.weightLbs}), 0)`,
        // How many of these units were actually weighed. Without it, a product whose
        // units carry no weight sums to 0 and prints "0.00 lb", which reads as "we
        // weighed it and it weighed nothing" — the same lie null avoids for shelves.
        weighed: sql<string>`count(${inventoryItems.weightLbs})`,
        // A unit with no case serial is its own case. Counting DISTINCT case_serial
        // alone would report zero cases for a shipment of singletons, which is how
        // the legacy's "20 cases / 20 pieces" would have come out as "0 / 20".
        cases: sql<string>`count(distinct coalesce(${inventoryItems.caseSerial}, ${inventoryItems.id}::text))`,
        pieces: sql<string>`count(*)`,
        value: sql<string>`coalesce(sum(coalesce(${inventoryItems.price}, ${products.price})), 0)`,
      })
      .from(inventoryItems)
      .innerJoin(products, eq(products.id, inventoryItems.productId))
      .where(and(...this.itemConds(ctx, storeIds, q, 'ON_HAND')))
      .groupBy(inventoryItems.storeId, products.id, products.sku, products.name)
      .orderBy(asc(products.sku));

    return rows.map((r) => {
      const anyWeighed = num(r.weighed) > 0;
      const weight = anyWeighed ? round2(num(r.weight)) : null;
      const cases = num(r.cases);
      const value = round2(num(r.value));
      return {
        storeId: r.storeId,
        productId: r.productId,
        sku: r.sku,
        name: r.name,
        trackingType: 'SERIALIZED' as const,
        weightLbs: weight,
        cases,
        pieces: num(r.pieces),
        // Weight over CASES, matching the legacy: 535.70 / 20 = 26.79.
        avgWeightLbs: weight != null && cases > 0 ? round2(weight / cases) : null,
        avgPricePerLb: weight != null && weight > 0 ? round2(value / weight) : null,
        value,
      };
    });
  }

  private async summaryQuantity(
    tx: Tx,
    ctx: DataContext,
    storeIds: number[],
    q: ReportQuery,
  ): Promise<(SummaryRow & { storeId: number })[]> {
    const conds: SQL[] = [eq(inventoryStock.companyId, ctx.companyId)];
    if (storeIds.length) conds.push(inArray(inventoryStock.storeId, storeIds));
    if (q.locationId != null)
      conds.push(eq(inventoryStock.locationId, q.locationId));
    if (q.productId != null)
      conds.push(eq(inventoryStock.productId, q.productId));

    const rows = await tx
      .select({
        storeId: inventoryStock.storeId,
        productId: products.id,
        sku: products.sku,
        name: products.name,
        pieces: sql<string>`coalesce(sum(${inventoryStock.quantityOnHand}), 0)`,
        value: sql<string>`coalesce(sum(${inventoryStock.quantityOnHand} * ${products.price}), 0)`,
      })
      .from(inventoryStock)
      .innerJoin(products, eq(products.id, inventoryStock.productId))
      .where(and(...conds))
      .groupBy(inventoryStock.storeId, products.id, products.sku, products.name)
      .orderBy(asc(products.sku));

    return rows
      .filter((r) => num(r.pieces) !== 0)
      .map((r) => ({
        storeId: r.storeId,
        productId: r.productId,
        sku: r.sku,
        name: r.name,
        trackingType: 'QUANTITY' as const,
        // Deliberately null, not zero. A shelf of caps has no weight recorded, and
        // printing 0.00 lb would read as "we weighed it and it weighed nothing".
        weightLbs: null,
        cases: null,
        pieces: num(r.pieces),
        avgWeightLbs: null,
        avgPricePerLb: null,
        value: round2(num(r.value)),
      }));
  }

  /** Units grouped by product, keyed by store. */
  private async unitGroups(
    tx: Tx,
    ctx: DataContext,
    storeIds: number[],
    q: ReportQuery,
    status: 'ON_HAND' | 'SOLD',
  ): Promise<Map<number, DetailGroup[]>> {
    const rows = await tx
      .select({
        storeId: inventoryItems.storeId,
        productId: products.id,
        sku: products.sku,
        name: products.name,
        serial: inventoryItems.serial,
        caseSerial: inventoryItems.caseSerial,
        weight: inventoryItems.weightLbs,
        locationName: storeLocations.name,
        receivedAt: inventoryItems.receivedAt,
        soldAt: inventoryItems.soldAt,
        price: sql<string>`coalesce(${inventoryItems.price}, ${products.price})`,
      })
      .from(inventoryItems)
      .innerJoin(products, eq(products.id, inventoryItems.productId))
      // LEFT: a unit whose location row was removed still exists and still has to
      // appear, rather than dropping out of a report of what is on the floor.
      .leftJoin(storeLocations, eq(storeLocations.id, inventoryItems.locationId))
      .where(and(...this.itemConds(ctx, storeIds, q, status)))
      .orderBy(asc(products.sku), asc(inventoryItems.serial));

    const byStore = new Map<number, Map<number, DetailGroup>>();
    for (const r of rows) {
      let perProduct = byStore.get(r.storeId);
      if (!perProduct) {
        perProduct = new Map<number, DetailGroup>();
        byStore.set(r.storeId, perProduct);
      }
      let g = perProduct.get(r.productId);
      if (!g) {
        g = {
          productId: r.productId,
          sku: r.sku,
          name: r.name,
          units: [],
          subtotal: { weightLbs: 0, pieces: 0, value: 0 },
        };
        perProduct.set(r.productId, g);
      }
      const weight = r.weight == null ? null : round2(num(r.weight));
      const value = round2(num(r.price));
      g.units.push({
        serial: r.serial,
        caseSerial: r.caseSerial ?? null,
        weightLbs: weight,
        locationName: r.locationName ?? null,
        receivedAt: r.receivedAt ? r.receivedAt.toISOString() : null,
        soldAt: r.soldAt ? r.soldAt.toISOString() : null,
        value,
        pricePerLb: weight && weight > 0 ? round2(value / weight) : null,
      });
      g.subtotal.weightLbs = round2((g.subtotal.weightLbs ?? 0) + (weight ?? 0));
      g.subtotal.pieces += 1;
      g.subtotal.value = round2(g.subtotal.value + value);
    }

    const out = new Map<number, DetailGroup[]>();
    for (const [storeId, perProduct] of byStore) {
      const groups = [...perProduct.values()];
      // Blank the weight of any group where nothing was actually weighed, rather than
      // reporting the 0 that summing nulls produces.
      for (const g of groups) {
        if (!g.units.some((u) => u.weightLbs != null)) g.subtotal.weightLbs = null;
      }
      out.set(storeId, groups);
    }
    return out;
  }

  // ---- header -----------------------------------------------------------

  /**
   * The stores to section the report into, in a stable order, as [id, name].
   *
   * Resolved up front rather than discovered from the rows, so a store with nothing in
   * scope still gets a heading: "Uptown — nothing on hand" is a finding, whereas a
   * store quietly absent from the page is a question. Also validates the request — an
   * id belonging to another company is refused rather than silently contributing
   * nothing, which would read as an empty store.
   */
  private async storeNames(
    tx: Tx,
    ctx: DataContext,
    storeIds: number[],
  ): Promise<[number, string][]> {
    const conds: SQL[] = [eq(stores.companyId, ctx.companyId)];
    if (storeIds.length) conds.push(inArray(stores.id, storeIds));
    const rows = await tx
      .select({ id: stores.id, name: stores.name })
      .from(stores)
      .where(and(...conds))
      .orderBy(asc(stores.name));

    if (storeIds.length && rows.length !== storeIds.length) {
      const found = new Set(rows.map((r) => r.id));
      const missing = storeIds.filter((id) => !found.has(id));
      throw new BadRequestException(`No such store: ${missing.join(', ')}.`);
    }
    return rows.map((r) => [r.id, r.name] as [number, string]);
  }

  /**
   * Who to say the email is from.
   *
   * DataContext carries ids, not names, so this is a lookup rather than a guess.
   * The username is preferred over the email: a recipient outside the company
   * recognises "mitchell" more readily than an address, and the address is in the
   * From header anyway.
   */
  private async senderName(ctx: DataContext): Promise<string> {
    const [u] = await this.tenantDb.withCompany(ctx.companyId, (tx) =>
      tx
        .select({ username: users.username, email: users.email })
        .from(users)
        .where(eq(users.id, ctx.userId))
        .limit(1),
    );
    return u?.username || u?.email || 'A colleague';
  }

  private async meta(
    tx: Tx,
    ctx: DataContext,
    kind: ReportKind,
    known: [number, string][],
    q: ReportQuery,
    storeIds: number[],
  ): Promise<ReportMeta> {
    const [company] = await tx
      .select({ name: companies.name })
      .from(companies)
      .where(eq(companies.id, ctx.companyId))
      .limit(1);

    let locationName: string | null = null;
    if (q.locationId != null) {
      const [l] = await tx
        .select({ name: storeLocations.name })
        .from(storeLocations)
        .where(
          and(
            eq(storeLocations.companyId, ctx.companyId),
            eq(storeLocations.id, q.locationId),
          ),
        )
        .limit(1);
      if (!l) throw new BadRequestException('That location does not exist.');
      locationName = l.name;
    }

    return {
      kind,
      title: TITLES[kind],
      generatedAt: new Date().toISOString(),
      companyName: company?.name ?? '',
      // Named only when the scope was actually narrowed. Listing every store when
      // none was chosen would put a paragraph in the header to say "all of them" —
      // and each store has its own heading in the body regardless.
      storeNames: storeIds.length ? known.map(([, name]) => name) : [],
      locationName,
      from: q.from ?? null,
      to: q.to ?? null,
    };
  }

  // ---- email ------------------------------------------------------------

  /**
   * Render the report and email it as attachments.
   *
   * The report is built through the SAME path the screen uses, so what lands in an
   * inbox is what the sender was looking at.
   *
   * The audit row is written whether or not delivery succeeded, and records the
   * recipients either way: "we tried to send this company's valuation to that
   * address" is the fact worth keeping, and a failure is exactly when somebody will
   * ask what happened.
   */
  async email(
    ctx: DataContext,
    dto: EmailReportDto,
  ): Promise<MailResult & { attached: string[] }> {
    const report = await this.build(ctx, dto.kind, dto);
    const formats = dto.formats?.length ? dto.formats : (['pdf', 'csv'] as const);

    const attachments: MailAttachment[] = [];
    for (const f of formats) {
      if (f === 'pdf') {
        attachments.push({
          filename: fileName(report, 'pdf'),
          contentType: 'application/pdf',
          content: await toPdf(report),
        });
      } else {
        attachments.push({
          filename: fileName(report, 'csv'),
          contentType: 'text/csv; charset=utf-8',
          // The BOM again, for the same reason the download has it: this gets opened
          // in Excel, and without it an accented product name arrives mangled.
          content: Buffer.from('﻿' + toCsv(report), 'utf8'),
        });
      }
    }

    const scopeLines: string[] = [
      `Stores: ${
        report.meta.storeNames.length
          ? report.meta.storeNames.join(', ')
          : 'All stores'
      }`,
    ];
    if (report.meta.locationName)
      scopeLines.push(`Location: ${report.meta.locationName}`);
    if (report.meta.from && report.meta.to)
      scopeLines.push(`Sold between ${report.meta.from} and ${report.meta.to}`);

    const result = await this.mail.sendReportEmail(
      dto.recipients,
      {
        reportTitle: report.meta.title,
        companyName: report.meta.companyName,
        scopeLines,
        senderName: await this.senderName(ctx),
        message: dto.message,
      },
      attachments,
    );

    if (!result.ok) {
      this.logger.warn(
        `report email failed for ${dto.recipients.join(', ')}: ${
          result.error ?? 'unknown'
        }`,
      );
    }

    await this.tenantDb.withCompany(ctx.companyId, (tx) =>
      this.audit.record(
        tx,
        ctx.companyId,
        { type: 'USER', userId: ctx.userId, source: 'WEB' },
        {
          entityType: 'REPORT',
          entityId: dto.kind,
          // A store id only when the report covers exactly one. A report spanning
          // several belongs to none of them, and the full list is in the details
          // rather than squeezed into a column that holds one number.
          storeId: dto.storeIds?.length === 1 ? dto.storeIds[0] : null,
        },
        'EMAILED',
        {
          details: {
            recipients: dto.recipients,
            formats,
            storeNames: report.meta.storeNames,
            storeSections: report.stores.length,
            attachments: attachments.map((a) => ({
              filename: a.filename,
              bytes: a.content.length,
            })),
            totalValue: report.totals.value,
            delivered: result.ok,
            error: result.error ?? null,
          },
        },
      ),
    );

    return { ...result, attached: attachments.map((a) => a.filename) };
  }
}

const TITLES: Record<ReportKind, string> = {
  SUMMARY: 'Inventory Summary With Value',
  DETAIL: 'Inventory Detail With Value',
  SOLD: 'Items Sold',
};
