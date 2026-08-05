import { Injectable } from '@nestjs/common';
import { auditEvents } from '../db/schema';
import { Tx } from '../db/tenant-db.service';
import { DataContext } from '../auth/auth.types';

/**
 * What kind of thing an event is about. Text, not an enum, so a new entity does not need a
 * migration — see the schema comment. Listed here because this service is the only writer,
 * which makes this the vocabulary.
 */
export type AuditEntityType =
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
  | 'RESOLVED'
  | 'OPENED'
  | 'SUBMITTED'
  | 'CLOSED';

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
  /** A user acting through the portal. */
  static web(ctx: DataContext): AuditActor {
    return { type: 'USER', userId: ctx.userId, source: 'WEB' };
  }

  /** A user acting through the handheld — the same person, a different door. */
  static scanner(ctx: DataContext): AuditActor {
    return { type: 'USER', userId: ctx.userId, source: 'SCANNER' };
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
    const a = before[key] ?? null;
    const b = (after[key] ?? null) as unknown;
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
