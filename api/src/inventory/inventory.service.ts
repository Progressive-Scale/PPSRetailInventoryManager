import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, isNull, SQL } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/drizzle.constants';
import { InventoryItem, inventoryItems, outboxChanges } from '../db/schema';
import { AuthUser } from '../auth/auth.types';
import { CreateInventoryItemDto } from './dto/create-inventory-item.dto';
import { UpdateInventoryItemDto } from './dto/update-inventory-item.dto';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

@Injectable()
export class InventoryService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * Restricts a query to the store the user may access. ADMINs are unrestricted
   * (they may optionally narrow to a single store).
   */
  private storeScope(user: AuthUser, adminStoreId?: number): SQL | undefined {
    if (user.role === 'ADMIN') {
      return adminStoreId !== undefined
        ? eq(inventoryItems.storeId, adminStoreId)
        : undefined;
    }
    if (user.storeId == null) {
      throw new BadRequestException('User is not assigned to a store.');
    }
    return eq(inventoryItems.storeId, user.storeId);
  }

  /** The store a write should target, enforcing the user's scope. */
  private resolveWriteStoreId(user: AuthUser, requestedStoreId?: number): number {
    if (user.role === 'ADMIN') {
      const storeId = requestedStoreId ?? user.storeId ?? undefined;
      if (storeId === undefined) {
        throw new BadRequestException(
          'ADMIN must specify storeId when creating inventory.',
        );
      }
      return storeId;
    }
    if (user.storeId == null) {
      throw new BadRequestException('User is not assigned to a store.');
    }
    // Store users may never write into another store's inventory.
    if (requestedStoreId !== undefined && requestedStoreId !== user.storeId) {
      throw new BadRequestException(
        'Cannot create inventory for a different store.',
      );
    }
    return user.storeId;
  }

  async findAll(user: AuthUser, adminStoreId?: number): Promise<InventoryItem[]> {
    const scope = this.storeScope(user, adminStoreId);
    return this.db
      .select()
      .from(inventoryItems)
      .where(and(isNull(inventoryItems.deletedAt), scope))
      .orderBy(desc(inventoryItems.updatedAt));
  }

  async findOne(user: AuthUser, id: string): Promise<InventoryItem> {
    const scope = this.storeScope(user);
    const [item] = await this.db
      .select()
      .from(inventoryItems)
      .where(
        and(eq(inventoryItems.id, id), isNull(inventoryItems.deletedAt), scope),
      )
      .limit(1);
    if (!item) {
      throw new NotFoundException('Inventory item not found.');
    }
    return item;
  }

  async create(
    user: AuthUser,
    dto: CreateInventoryItemDto,
  ): Promise<InventoryItem> {
    const storeId = this.resolveWriteStoreId(user, dto.storeId);

    return this.db.transaction(async (tx) => {
      const [item] = await tx
        .insert(inventoryItems)
        .values({
          storeId,
          sku: dto.sku,
          name: dto.name,
          description: dto.description ?? null,
          quantity: dto.quantity ?? 0,
          price: dto.price !== undefined ? String(dto.price) : '0',
        })
        .returning()
        .catch(this.rethrowUniqueViolation);

      await this.recordOutbox(tx, 'CREATE', item);
      return item;
    });
  }

  async update(
    user: AuthUser,
    id: string,
    dto: UpdateInventoryItemDto,
  ): Promise<InventoryItem> {
    // Enforce scope + existence first (throws if not visible to this user).
    await this.findOne(user, id);

    const patch: Partial<typeof inventoryItems.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (dto.sku !== undefined) patch.sku = dto.sku;
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.description !== undefined) patch.description = dto.description;
    if (dto.quantity !== undefined) patch.quantity = dto.quantity;
    if (dto.price !== undefined) patch.price = String(dto.price);

    return this.db.transaction(async (tx) => {
      const [item] = await tx
        .update(inventoryItems)
        .set(patch)
        .where(and(eq(inventoryItems.id, id), isNull(inventoryItems.deletedAt)))
        .returning()
        .catch(this.rethrowUniqueViolation);

      if (!item) {
        throw new NotFoundException('Inventory item not found.');
      }
      await this.recordOutbox(tx, 'UPDATE', item);
      return item;
    });
  }

  async remove(user: AuthUser, id: string): Promise<InventoryItem> {
    await this.findOne(user, id);

    const now = new Date();
    return this.db.transaction(async (tx) => {
      const [item] = await tx
        .update(inventoryItems)
        .set({ deletedAt: now, updatedAt: now })
        .where(and(eq(inventoryItems.id, id), isNull(inventoryItems.deletedAt)))
        .returning();

      if (!item) {
        throw new NotFoundException('Inventory item not found.');
      }
      await this.recordOutbox(tx, 'DELETE', item);
      return item;
    });
  }

  /** Insert the change into the outbox within the same transaction. */
  private async recordOutbox(
    tx: Tx,
    operation: 'CREATE' | 'UPDATE' | 'DELETE',
    item: InventoryItem,
  ): Promise<void> {
    await tx.insert(outboxChanges).values({
      storeId: item.storeId,
      entity: 'inventory_items',
      entityId: item.id,
      operation,
      payload: item,
    });
  }

  private rethrowUniqueViolation = (err: unknown): never => {
    // Postgres unique_violation
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code?: string }).code === '23505'
    ) {
      throw new ConflictException('An item with that SKU already exists.');
    }
    throw err;
  };
}
