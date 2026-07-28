import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, or } from 'drizzle-orm';
import { TenantDbService, Tx } from '../db/tenant-db.service';
import {
  inventoryItems,
  inventoryStock,
  inventoryTransactions,
  StoreLocation,
  storeLocations,
  stores,
} from '../db/schema';
import { DataContext } from '../auth/auth.types';
import {
  CreateLocationDto,
  ReorderLocationsDto,
  UpdateLocationDto,
} from './dto/locations.dto';

@Injectable()
export class LocationsService {
  constructor(private readonly tenantDb: TenantDbService) {}

  /** Store a read/write must target, enforcing STORE_USER scope. */
  private storeId(ctx: DataContext, requested?: number): number {
    if (ctx.role === 'STORE_USER') {
      if (ctx.storeId == null) {
        throw new BadRequestException('User is not assigned to a store.');
      }
      if (requested !== undefined && requested !== ctx.storeId) {
        throw new BadRequestException('Cannot act on another store.');
      }
      return ctx.storeId;
    }
    if (requested === undefined) {
      throw new BadRequestException('storeId is required.');
    }
    return requested;
  }

  private async assertStore(tx: Tx, companyId: number, storeId: number) {
    const [row] = await tx
      .select({ id: stores.id })
      .from(stores)
      .where(and(eq(stores.id, storeId), eq(stores.companyId, companyId)))
      .limit(1);
    if (!row) throw new NotFoundException('Store not found.');
  }

  private async load(
    tx: Tx,
    ctx: DataContext,
    id: number,
  ): Promise<StoreLocation> {
    const [row] = await tx
      .select()
      .from(storeLocations)
      .where(
        and(
          eq(storeLocations.id, id),
          eq(storeLocations.companyId, ctx.companyId),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException('Location not found.');
    if (ctx.role === 'STORE_USER' && row.storeId !== ctx.storeId) {
      throw new NotFoundException('Location not found.');
    }
    return row;
  }

  // ---- reads -------------------------------------------------------------

  async list(ctx: DataContext, requestedStoreId?: number) {
    const storeId = this.storeId(ctx, requestedStoreId);
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      await this.assertStore(tx, ctx.companyId, storeId);
      return tx
        .select()
        .from(storeLocations)
        .where(
          and(
            eq(storeLocations.companyId, ctx.companyId),
            eq(storeLocations.storeId, storeId),
          ),
        )
        .orderBy(asc(storeLocations.sortOrder), asc(storeLocations.id));
    });
  }

  // ---- writes (COMPANY_ADMIN) --------------------------------------------

  async create(ctx: DataContext, dto: CreateLocationDto) {
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      await this.assertStore(tx, ctx.companyId, dto.storeId);
      // Place new custom locations after existing ones.
      const existing = await tx
        .select({ sortOrder: storeLocations.sortOrder })
        .from(storeLocations)
        .where(
          and(
            eq(storeLocations.companyId, ctx.companyId),
            eq(storeLocations.storeId, dto.storeId),
          ),
        );
      const nextSort =
        existing.reduce((m, r) => Math.max(m, r.sortOrder), -1) + 1;
      try {
        const [row] = await tx
          .insert(storeLocations)
          .values({
            companyId: ctx.companyId,
            storeId: dto.storeId,
            name: dto.name.trim(),
            kind: 'CUSTOM',
            sortOrder: nextSort,
            isActive: dto.isActive ?? true,
          })
          .returning();
        return row;
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictException(
            `A location named "${dto.name}" already exists in this store.`,
          );
        }
        throw err;
      }
    });
  }

  async update(ctx: DataContext, id: number, dto: UpdateLocationDto) {
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      const loc = await this.load(tx, ctx, id); // scope + existence
      const patch: Record<string, unknown> = {};
      if (dto.name !== undefined) patch.name = dto.name.trim();
      if (dto.sortOrder !== undefined) patch.sortOrder = dto.sortOrder;
      if (dto.isActive !== undefined && dto.isActive !== loc.isActive) {
        if (!dto.isActive) {
          // Deactivating: system locations are permanent, and a location must
          // be empty before it can be turned off.
          if (loc.kind !== 'CUSTOM') {
            throw new BadRequestException(
              'System locations (Backroom / On Floor) cannot be deactivated.',
            );
          }
          if (await this.locationOccupied(tx, ctx.companyId, id)) {
            throw new ConflictException(
              'Move inventory out of this location before deactivating it.',
            );
          }
        }
        patch.isActive = dto.isActive;
      }
      if (Object.keys(patch).length === 0) {
        throw new BadRequestException('Nothing to update.');
      }
      try {
        const [row] = await tx
          .update(storeLocations)
          .set(patch)
          .where(
            and(
              eq(storeLocations.id, id),
              eq(storeLocations.companyId, ctx.companyId),
            ),
          )
          .returning();
        return row;
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictException(
            `A location named "${dto.name}" already exists in this store.`,
          );
        }
        throw err;
      }
    });
  }

  async reorder(ctx: DataContext, dto: ReorderLocationsDto) {
    const storeId = this.storeId(ctx, dto.storeId);
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      await this.assertStore(tx, ctx.companyId, storeId);
      const rows = await tx
        .select({ id: storeLocations.id })
        .from(storeLocations)
        .where(
          and(
            eq(storeLocations.companyId, ctx.companyId),
            eq(storeLocations.storeId, storeId),
          ),
        );
      const known = new Set(rows.map((r) => r.id));
      if (
        dto.orderedIds.length !== known.size ||
        !dto.orderedIds.every((id) => known.has(id))
      ) {
        throw new BadRequestException(
          'orderedIds must list every location in the store exactly once.',
        );
      }
      let sort = 0;
      for (const id of dto.orderedIds) {
        await tx
          .update(storeLocations)
          .set({ sortOrder: sort++ })
          .where(
            and(
              eq(storeLocations.id, id),
              eq(storeLocations.companyId, ctx.companyId),
            ),
          );
      }
      return tx
        .select()
        .from(storeLocations)
        .where(
          and(
            eq(storeLocations.companyId, ctx.companyId),
            eq(storeLocations.storeId, storeId),
          ),
        )
        .orderBy(asc(storeLocations.sortOrder), asc(storeLocations.id));
    });
  }

  /**
   * Permanently delete a CUSTOM location. System locations can't be deleted, and
   * a location that still holds inventory or has any movement history can't be
   * removed (the ledger references it) — deactivate it instead.
   */
  async remove(ctx: DataContext, id: number) {
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      const loc = await this.load(tx, ctx, id);
      if (loc.kind !== 'CUSTOM') {
        throw new BadRequestException(
          'System locations (Backroom / On Floor) cannot be deleted.',
        );
      }
      if (await this.locationOccupied(tx, ctx.companyId, id)) {
        throw new ConflictException(
          'Move inventory out of this location before deleting it.',
        );
      }
      const [hist] = await tx
        .select({ id: inventoryTransactions.id })
        .from(inventoryTransactions)
        .where(
          and(
            eq(inventoryTransactions.companyId, ctx.companyId),
            or(
              eq(inventoryTransactions.locationFromId, id),
              eq(inventoryTransactions.locationToId, id),
            ),
          ),
        )
        .limit(1);
      if (hist) {
        throw new ConflictException(
          'This location has movement history and cannot be deleted — set it Inactive instead.',
        );
      }
      await tx
        .delete(storeLocations)
        .where(
          and(
            eq(storeLocations.id, id),
            eq(storeLocations.companyId, ctx.companyId),
          ),
        );
      return { deleted: true, id };
    });
  }

  private async locationOccupied(
    tx: Tx,
    companyId: number,
    locationId: number,
  ): Promise<boolean> {
    const items = await tx
      .select({ id: inventoryItems.id })
      .from(inventoryItems)
      .where(
        and(
          eq(inventoryItems.companyId, companyId),
          eq(inventoryItems.locationId, locationId),
          eq(inventoryItems.status, 'ON_HAND'),
        ),
      )
      .limit(1);
    if (items.length > 0) return true;
    const stock = await tx
      .select({ id: inventoryStock.id })
      .from(inventoryStock)
      .where(
        and(
          eq(inventoryStock.companyId, companyId),
          eq(inventoryStock.locationId, locationId),
        ),
      )
      .limit(1);
    return stock.length > 0;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === '23505'
  );
}
