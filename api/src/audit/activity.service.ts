import { Injectable } from '@nestjs/common';
import { sql, SQL } from 'drizzle-orm';
import { TenantDbService } from '../db/tenant-db.service';
import { Paginated } from '../common/pagination';

/** Which stream a row came from. Kept on the row because the two mean different things. */
export type ActivityKind = 'AUDIT' | 'LEDGER';

/** Normalised source. The ledger's own vocabulary is mapped onto this one — see below. */
export type ActivitySource = 'WEB' | 'SCANNER' | 'SYNC' | 'JOB';

export interface ActivityRow {
  /** Unique across the union: the two streams have independent id sequences. */
  id: string;
  kind: ActivityKind;
  at: Date;
  actorType: 'USER' | 'SYNC_AGENT' | 'SYSTEM_JOB';
  userId: number | null;
  /** username / 'Sync' / 'System' — what a reader should see. */
  actor: string;
  source: ActivitySource;
  storeId: number | null;
  storeName: string | null;
  entityType: string;
  entityId: string;
  action: string;
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
  details: Record<string, unknown> | null;
  /** One line describing the event, ready to render. */
  summary: string;
  /** Ledger extras, so a movement row can say what moved and where. */
  quantityDelta: number | null;
  productId: number | null;
  sku: string | null;
  productName: string | null;
  serial: string | null;
  locationFrom: string | null;
  locationTo: string | null;
  cycleCountId: number | null;
  note: string | null;
}

export interface ActivityFilters {
  userId?: number;
  entityType?: string;
  entityId?: string;
  action?: string;
  storeId?: number;
  /**
   * With storeId, also admit rows that belong to no store (catalog edits, alert settings).
   * A company-wide change is not another store's private business, and excluding it would
   * make a product's history empty for anyone pinned to a store.
   */
  includeCompanyWide?: boolean;
  /**
   * Free text over actor, store, product, serial and the action itself. Only the global
   * feed passes it — one entity's own history is already narrowed to that entity.
   */
  search?: string;
  source?: ActivitySource;
  /** Inclusive lower bound / exclusive upper bound on the event time. */
  from?: Date;
  to?: Date;
}

/**
 * The read side of the audit trail: ONE stream from two tables.
 *
 * audit_events records who changed what; inventory_transactions records where stock went.
 * They are unioned at read time rather than merged at write time, because the alternative —
 * writing every movement into both — creates two records of one fact that can disagree, and
 * a ledger that disagrees with the audit log is worse than having only one of them.
 *
 * SQL rather than a view: the mapping is one query with filters pushed into it, so ordering
 * and paging happen once across the whole stream. Two separately-paginated queries merged in
 * TypeScript would return the wrong page as soon as one stream ran ahead of the other.
 *
 * Every query runs through withCompany, so RLS scopes both tables — this service never adds
 * a company filter of its own beyond the one the policies already enforce.
 */
@Injectable()
export class ActivityService {
  constructor(private readonly tenantDb: TenantDbService) {}

  async list(
    companyId: number,
    filters: ActivityFilters,
    paging: { limit: number; offset: number },
  ): Promise<Paginated<ActivityRow>> {
    const where = this.buildWhere(filters);
    return this.tenantDb.withCompany(companyId, async (tx) => {
      const page = await tx.execute(sql`
        ${this.stream()}
        SELECT s.*,
               COALESCE(s.product_id, i.product_id) AS resolved_product_id,
               u.username                AS actor_username,
               st.name                   AS store_name,
               p.sku                     AS sku,
               p.name                    AS product_name,
               i.serial                  AS serial,
               lf.name                   AS location_from,
               lt.name                   AS location_to
        FROM stream s
        LEFT JOIN users u            ON u.id = s.user_id
        LEFT JOIN stores st          ON st.id = s.store_id
        LEFT JOIN inventory_items i  ON s.entity_type = 'INVENTORY_ITEM'
                                    AND i.id::text = s.entity_id
        -- Ledger rows name their product directly; an audit row on a unit gets it through
        -- the unit, so "changed the weight of SN-1008" reads as a thing rather than a uuid.
        LEFT JOIN products p         ON p.id = COALESCE(s.product_id, i.product_id)
        LEFT JOIN store_locations lf ON lf.id = s.location_from_id
        LEFT JOIN store_locations lt ON lt.id = s.location_to_id
        ${where}
        -- kind breaks ties so a movement and the edit that caused it keep a stable order
        -- across pages; two rows sharing a timestamp to the microsecond is otherwise a
        -- coin flip and the same row can appear on two pages.
        ORDER BY s.at DESC, s.kind ASC, s.row_id DESC
        LIMIT ${paging.limit} OFFSET ${paging.offset}`);

      // The same joins as the page query, not because the count needs the columns but
      // because the WHERE can now reference them: search matches a product name or a
      // serial, and a count query that could not see those would report a total for a
      // different set of rows than the one on screen.
      const counted = await tx.execute(sql`
        ${this.stream()}
        SELECT count(*)::int AS n
        FROM stream s
        LEFT JOIN users u            ON u.id = s.user_id
        LEFT JOIN stores st          ON st.id = s.store_id
        LEFT JOIN inventory_items i  ON s.entity_type = 'INVENTORY_ITEM'
                                    AND i.id::text = s.entity_id
        LEFT JOIN products p         ON p.id = COALESCE(s.product_id, i.product_id)
        ${where}`);

      const rows = (page as unknown as { rows: Record<string, unknown>[] }).rows;
      const total = Number(
        (counted as unknown as { rows: Array<{ n: number }> }).rows[0]?.n ?? 0,
      );
      return {
        data: rows.map((r) => this.toRow(r)),
        total,
        limit: paging.limit,
        offset: paging.offset,
      };
    });
  }

  /**
   * The union, as a CTE. Both halves project the same column list in the same order,
   * which is what UNION ALL requires and what makes the casts on the NULLs necessary.
   */
  private stream(): SQL {
    return sql`
      WITH stream AS (
        SELECT 'AUDIT'::text          AS kind,
               a.id::bigint           AS row_id,
               a.created_at           AS at,
               a.actor_type::text     AS actor_type,
               a.user_id              AS user_id,
               a.store_id             AS store_id,
               a.entity_type          AS entity_type,
               a.entity_id            AS entity_id,
               a.action               AS action,
               a.field                AS field,
               a.old_value            AS old_value,
               a.new_value            AS new_value,
               a.details              AS details,
               a.source::text         AS source,
               NULL::int              AS quantity_delta,
               NULL::text             AS note,
               NULL::int              AS product_id,
               NULL::int              AS location_from_id,
               NULL::int              AS location_to_id,
               NULL::int              AS cycle_count_id
        FROM audit_events a
        UNION ALL
        SELECT 'LEDGER'::text,
               t.id::bigint,
               t.created_at,
               -- The ledger predates actor_type: it records a user id and a source, so the
               -- actor kind is inferred. A row with a user is that user's action even when
               -- the source is CYCLE_COUNT, because a person approved it.
               CASE
                 WHEN t.performed_by_user_id IS NOT NULL THEN 'USER'
                 WHEN t.source = 'SYNC' THEN 'SYNC_AGENT'
                 ELSE 'SYSTEM_JOB'
               END,
               t.performed_by_user_id,
               t.store_id,
               -- A serialized movement is about the unit; a quantity movement has no unit,
               -- so it belongs to the product. Both are entities the UI can link to.
               CASE WHEN t.item_id IS NOT NULL THEN 'INVENTORY_ITEM' ELSE 'PRODUCT' END,
               COALESCE(t.item_id::text, t.product_id::text, ''),
               t.type::text,
               NULL::text, NULL::text, NULL::text, NULL::jsonb,
               -- transaction_source is PORTAL|SYNC|CYCLE_COUNT; the stream speaks
               -- WEB|SCANNER|SYNC|JOB. PORTAL and CYCLE_COUNT both mean "someone did this
               -- in the app" — the ledger cannot tell a handheld from a browser, and
               -- guessing SCANNER from CYCLE_COUNT would be wrong for an approval, which
               -- always happens in the portal.
               CASE WHEN t.source = 'SYNC' THEN 'SYNC' ELSE 'WEB' END,
               t.quantity_delta,
               t.note,
               t.product_id,
               t.location_from_id,
               t.location_to_id,
               t.cycle_count_id
        FROM inventory_transactions t
      )`;
  }

  private buildWhere(f: ActivityFilters): SQL {
    const conds: SQL[] = [];
    if (f.userId != null) conds.push(sql`s.user_id = ${f.userId}`);
    if (f.entityType) conds.push(sql`s.entity_type = ${f.entityType}`);
    if (f.entityId) conds.push(sql`s.entity_id = ${f.entityId}`);
    if (f.action) conds.push(sql`s.action = ${f.action}`);
    if (f.storeId != null) {
      conds.push(
        f.includeCompanyWide
          ? sql`(s.store_id = ${f.storeId} OR s.store_id IS NULL)`
          : sql`s.store_id = ${f.storeId}`,
      );
    }
    // Free text across everything the feed actually renders: who did it, where, to
    // what, and the verb itself. The joined columns are available because both the
    // page query and the count query carry the same joins — they have to, or the
    // pager would describe a different set than the rows do.
    const term = f.search?.trim();
    if (term) {
      const like = `%${term}%`;
      conds.push(sql`(
        u.username    ILIKE ${like} OR
        st.name       ILIKE ${like} OR
        p.sku         ILIKE ${like} OR
        p.name        ILIKE ${like} OR
        i.serial      ILIKE ${like} OR
        s.action      ILIKE ${like} OR
        s.entity_type ILIKE ${like} OR
        s.entity_id   ILIKE ${like}
      )`);
    }
    if (f.source) conds.push(sql`s.source = ${f.source}`);
    if (f.from) conds.push(sql`s.at >= ${f.from.toISOString()}`);
    // Exclusive, so a caller can pass midnight for "up to yesterday" without the boundary
    // second belonging to two ranges.
    if (f.to) conds.push(sql`s.at < ${f.to.toISOString()}`);
    if (conds.length === 0) return sql``;
    return sql` WHERE ${sql.join(conds, sql` AND `)}`;
  }

  private toRow(r: Record<string, unknown>): ActivityRow {
    const actorType = String(r.actor_type) as ActivityRow['actorType'];
    const username = (r.actor_username as string | null) ?? null;
    const row: ActivityRow = {
      id: `${r.kind === 'AUDIT' ? 'A' : 'L'}${String(r.row_id)}`,
      kind: r.kind as ActivityKind,
      at: new Date(r.at as string),
      actorType,
      userId: (r.user_id as number | null) ?? null,
      // A deleted user leaves rows behind — the id stayed, the name did not, and
      // "user #7" is more honest than a blank.
      actor:
        actorType === 'USER'
          ? (username ?? `user #${String(r.user_id ?? '?')}`)
          : actorType === 'SYNC_AGENT'
            ? 'Sync'
            : 'System',
      source: String(r.source) as ActivitySource,
      storeId: (r.store_id as number | null) ?? null,
      storeName: (r.store_name as string | null) ?? null,
      entityType: String(r.entity_type),
      entityId: String(r.entity_id),
      action: String(r.action),
      field: (r.field as string | null) ?? null,
      oldValue: (r.old_value as string | null) ?? null,
      newValue: (r.new_value as string | null) ?? null,
      details: (r.details as Record<string, unknown> | null) ?? null,
      summary: '',
      quantityDelta: (r.quantity_delta as number | null) ?? null,
      productId: (r.resolved_product_id as number | null) ?? null,
      sku: (r.sku as string | null) ?? null,
      productName: (r.product_name as string | null) ?? null,
      serial: (r.serial as string | null) ?? null,
      locationFrom: (r.location_from as string | null) ?? null,
      locationTo: (r.location_to as string | null) ?? null,
      cycleCountId: (r.cycle_count_id as number | null) ?? null,
      note: (r.note as string | null) ?? null,
    };
    row.summary = summarise(row);
    return row;
  }
}

/**
 * The one-line description, built here rather than in SQL so it stays readable, and
 * server-side rather than in the browser so the API and any future export say the same
 * thing about the same row.
 */
export function summarise(r: ActivityRow): string {
  // A unit created from an unknown serial has no product yet, so the serial is all there is
  // to name it by — and those units are exactly the ones someone is trying to trace.
  const subject = r.sku
    ? `${r.sku}${r.serial ? ` / ${r.serial}` : ''}`
    : (r.serial ?? null);

  if (r.kind === 'LEDGER') {
    const qty = r.quantityDelta ?? 0;
    const what = subject ?? r.productName ?? 'stock';
    switch (r.action) {
      case 'MOVE':
        return `Moved ${what}${
          r.locationFrom || r.locationTo
            ? ` (${r.locationFrom ?? '?'} → ${r.locationTo ?? '?'})`
            : ''
        }`;
      case 'SALE':
        return `Sold ${Math.abs(qty) || 1} × ${what}`;
      case 'RECEIPT':
        return `Received ${Math.abs(qty) || 1} × ${what}`;
      case 'RETURN':
        return `Returned ${Math.abs(qty) || 1} × ${what}`;
      default:
        // ADJUSTMENT covers a lot of ground, so the note earns its place here: it is
        // where write-offs, reinstatements and adoptions say what they were.
        return r.note ?? `Adjusted ${what}`;
    }
  }

  const entity = ENTITY_LABEL[r.entityType] ?? r.entityType.toLowerCase();
  const name = subject ?? entityName(r) ?? `#${r.entityId}`;

  if (r.action === 'UPDATED' && r.field) {
    return `Changed ${r.field.replace(/_/g, ' ')} on ${entity} ${name}: ${
      r.oldValue ?? '—'
    } → ${r.newValue ?? '—'}`;
  }
  const verb = ACTION_VERB[r.action] ?? r.action.toLowerCase();
  return `${verb.charAt(0).toUpperCase()}${verb.slice(1)} ${entity} ${name}`;
}

/** Whatever the details carry that names the thing, in the order a reader would want it. */
function entityName(r: ActivityRow): string | null {
  const d = r.details ?? {};
  for (const key of ['sku', 'email', 'name', 'serial', 'scope']) {
    const v = d[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

const ENTITY_LABEL: Record<string, string> = {
  PRODUCT: 'product',
  INVENTORY_ITEM: 'item',
  LOCATION: 'location',
  REORDER: 'reorder',
  CYCLE_COUNT: 'cycle count',
  INVITATION: 'invitation',
  USER: 'user',
  NOTIFICATION_SETTINGS: 'alert settings',
};

const ACTION_VERB: Record<string, string> = {
  CREATED: 'created',
  DELETED: 'deleted',
  DEACTIVATED: 'deactivated',
  REACTIVATED: 'reactivated',
  REVOKED: 'revoked',
  RESENT: 'resent',
  CANCELLED: 'cancelled',
  ACKNOWLEDGED: 'acknowledged',
  RESOLVED: 'resolved',
  OPENED: 'opened',
  SUBMITTED: 'submitted',
  CLOSED: 'approved',
  REJECTED: 'sent back',
  UPDATED: 'updated',
};
