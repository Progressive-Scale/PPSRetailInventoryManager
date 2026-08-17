import { Injectable } from '@nestjs/common';
import { auditEvents } from '../db/schema';
import { users } from '../db/schema';
import { and, eq } from 'drizzle-orm';
import { Tx } from '../db/tenant-db.service';
import { DataContext } from '../auth/auth.types';

/**
 * What kind of thing an event is about. Text, not an enum, so a new entity does not need a
 * migration — see the schema comment. Listed here because this service is the only writer,
 * which makes this the vocabulary.
 */
export type AuditEntityType =
  // The company record itself. Written by the platform admin — moving a company
  // between scanner release channels is a change TO that company, and one its own
  // people can see happened even though only the platform can make it.
  | 'COMPANY'
  | 'PRODUCT'
  | 'INVENTORY_ITEM'
  | 'LOCATION'
  | 'REORDER'
  | 'CYCLE_COUNT'
  | 'INVITATION'
  | 'USER'
  | 'NOTIFICATION_SETTINGS';

/**
 * What happened to it. Also open: add a verb here and emit it, no migration.
 *
 * UPDATED is the one used with `field`; the rest describe an event rather than a diff.
 */
export type AuditAction =
  | 'CREATED'
  | 'UPDATED'
  | 'DELETED'
  | 'DEACTIVATED'
  | 'REACTIVATED'
  | 'REVOKED'
  | 'RESENT'
  | 'CANCELLED'
  | 'ACKNOWLEDGED'
  // The consuming ERP's answer to a reorder it will not fill. Kept apart from CANCELLED,
  // which is the store changing its own mind: only one of the two is a refusal, and the
  // trail should say which happened.
  | 'DECLINED'
  | 'RESOLVED'
  | 'OPENED'
  | 'SUBMITTED'
  | 'CLOSED'
  | 'REJECTED';

export type AuditSource = 'WEB' | 'SCANNER' | 'SYNC' | 'JOB';

/** Who acted. Exactly one of these three shapes, so an actor can never be half-set. */
export type AuditActor =
  | { type: 'USER'; userId: number; source: Exclude<AuditSource, 'SYNC' | 'JOB'> }
  | { type: 'SYNC_AGENT'; apiKeyId: number | null }
  | { type: 'SYSTEM_JOB' };

export interface AuditTarget {
  entityType: AuditEntityType;
  /** Coerced to text: item ids are uuids, everything else is an int. */
  entityId: string | number;
  /** The store it belongs to, when it belongs to one. */
  storeId?: number | null;
}

/** One changed field, as the diff helper produces them. */
export interface FieldChange {
  field: string;
  oldValue: string | null;
  newValue: string | null;
}

/**
 * The only writer of audit_events.
 *
 * Every method takes the caller's `Tx`, so an event is written inside the same transaction
 * as the change it describes: if the change rolls back, so does its audit row, and there is
 * no window where one exists without the other.
 *
 * Inventory MOVEMENTS are deliberately absent. inventory_transactions is the audit of
 * stock moving; duplicating it here would create two records that can disagree. The read
 * model unions the two instead.
 */
@Injectable()
export class AuditService {
  /**
   * The signed-in user, with the door they came through taken from their context — so a
   * count submitted from the handheld and one submitted from the portal are the same person
   * and distinguishable events, without every call site having to know which it is.
   */
  static user(ctx: DataContext): AuditActor {
    return { type: 'USER', userId: ctx.userId, source: ctx.client ?? 'WEB' };
  }

  /** The sync agent, identified by the key it presented. */
  static agent(apiKeyId: number | null): AuditActor {
    return { type: 'SYNC_AGENT', apiKeyId };
  }

  /** A scheduled job, with nobody behind it. */
  static job(): AuditActor {
    return { type: 'SYSTEM_JOB' };
  }

  /**
   * The acting user, but ONLY if they belong to the company the event is about.
   *
   * A platform admin acting on a tenant's behalf is not one of that tenant's people: their
   * user row lives in another company, so storing the id here would put a name the tenant
   * can never resolve into the tenant's own history — and their audit read joins users
   * inside their own company, so it would render as a blank actor. Those events are
   * recorded as a system actor instead, which is honest: something outside the company did
   * this. Callers add a detail saying so.
   *
   * Works under RLS and under bypass: the company_id is checked explicitly rather than
   * relying on the policy to hide the row.
   */
  async actorForCompany(
    tx: Tx,
    companyId: number,
    userId: number | null,
    source: Exclude<AuditSource, 'SYNC' | 'JOB'> = 'WEB',
  ): Promise<AuditActor> {
    if (userId == null) return AuditService.job();
    const [row] = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, userId), eq(users.companyId, companyId)))
      .limit(1);
    return row ? { type: 'USER', userId, source } : AuditService.job();
  }

  /**
   * Record one event. `details` carries context for events that are not field edits —
   * tallies, external references, reasons.
   */
  async record(
    tx: Tx,
    companyId: number,
    actor: AuditActor,
    target: AuditTarget,
    action: AuditAction,
    opts: {
      field?: string | null;
      oldValue?: string | null;
      newValue?: string | null;
      details?: Record<string, unknown> | null;
    } = {},
  ): Promise<void> {
    await tx.insert(auditEvents).values({
      companyId,
      storeId: target.storeId ?? null,
      actorType: actor.type,
      userId: actor.type === 'USER' ? actor.userId : null,
      apiKeyId: actor.type === 'SYNC_AGENT' ? actor.apiKeyId : null,
      entityType: target.entityType,
      entityId: String(target.entityId),
      action,
      field: opts.field ?? null,
      oldValue: opts.oldValue ?? null,
      newValue: opts.newValue ?? null,
      details: opts.details ?? null,
      source: this.sourceFor(actor),
    });
  }

  /**
   * Record a multi-field edit as ONE ROW PER CHANGED FIELD.
   *
   * Per-field rows are what make "who changed the price" a query instead of a jsonb dig,
   * and they let one field's history read cleanly even when it was edited alongside others.
   * Nothing is written when nothing changed — re-saving a form is not an edit.
   */
  async recordChanges(
    tx: Tx,
    companyId: number,
    actor: AuditActor,
    target: AuditTarget,
    changes: FieldChange[],
    details?: Record<string, unknown> | null,
  ): Promise<number> {
    if (changes.length === 0) return 0;
    for (const c of changes) {
      await this.record(tx, companyId, actor, target, 'UPDATED', {
        field: c.field,
        oldValue: c.oldValue,
        newValue: c.newValue,
        details: details ?? null,
      });
    }
    return changes.length;
  }

  private sourceFor(actor: AuditActor): AuditSource {
    switch (actor.type) {
      case 'USER':
        return actor.source;
      case 'SYNC_AGENT':
        return 'SYNC';
      case 'SYSTEM_JOB':
        return 'JOB';
    }
  }
}

/**
 * The diff every caller should use: compares only the fields the request actually carried,
 * and only reports the ones that really changed.
 *
 * `before` and `after` are compared as STRINGS because that is how the columns store them,
 * with an optional per-field normaliser for the cases where equal values have different
 * spellings — numeric('12.4') and numeric('12.400') are the same weight, and logging that
 * as an edit is worse than logging nothing.
 */
export function diffFields<T extends Record<string, unknown>>(
  before: T,
  after: Partial<T>,
  opts: {
    /** Only these keys are considered, in this order. */
    fields: Array<keyof T & string>;
    /** Column name per field, when it differs from the property name. */
    columnFor?: Partial<Record<keyof T & string, string>>;
    /** Per-field comparison normaliser (e.g. Number for numerics). */
    normalise?: Partial<Record<keyof T & string, (v: unknown) => unknown>>;
  },
): FieldChange[] {
  const out: FieldChange[] = [];
  for (const key of opts.fields) {
    if (!(key in after)) continue; // not part of this request — not an edit
    const norm = opts.normalise?.[key] ?? ((v: unknown) => v);
    // An empty string and NULL are the same absence, so a form that submits '' for a field
    // that was never set is not an edit. Write paths normalise blanks to NULL anyway; this
    // is here so one that forgets cannot fill the trail with "— → " rows.
    const a = empty(before[key]) ? null : before[key];
    const b = empty(after[key]) ? null : (after[key] as unknown);
    const same =
      a === null && b === null
        ? true
        : a === null || b === null
          ? false
          : norm(a) === norm(b) || String(a) === String(b);
    if (same) continue;
    out.push({
      field: opts.columnFor?.[key] ?? key,
      oldValue: a === null ? null : String(a),
      newValue: b === null ? null : String(b),
    });
  }
  return out;
}

/** Nothing there: null, undefined, or a string with only whitespace in it. */
function empty(value: unknown): boolean {
  return value == null || (typeof value === 'string' && value.trim() === '');
}
