import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsPositive, IsUUID } from 'class-validator';
import { and, desc, eq, sql, SQL } from 'drizzle-orm';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { Ctx } from '../auth/current-user.decorator';
import { DataContext } from '../auth/auth.types';
import { TenantDbService } from '../db/tenant-db.service';
import { inventoryTransactions } from '../db/schema';
import { Paginated, PaginationQuery, resolvePaging } from '../common/pagination';

const TX_TYPES = ['RECEIPT', 'SALE', 'ADJUSTMENT', 'RETURN'] as const;

class ListTransactionsQuery extends PaginationQuery {
  @IsOptional()
  @IsUUID()
  itemId?: string;

  @IsOptional()
  @IsEnum(TX_TYPES as unknown as string[])
  type?: (typeof TX_TYPES)[number];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  storeId?: number;
}

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(['COMPANY_ADMIN', 'STORE_USER'])
@Controller('transactions')
export class TransactionsController {
  constructor(private readonly tenantDb: TenantDbService) {}

  @Get()
  async list(
    @Ctx() ctx: DataContext,
    @Query() query: ListTransactionsQuery,
  ): Promise<Paginated<unknown>> {
    const { limit, offset } = resolvePaging(query);

    // STORE_USER pinned to their store; COMPANY_ADMIN may filter by store.
    const storeId =
      ctx.role === 'STORE_USER' ? ctx.storeId : (query.storeId ?? null);

    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      const conds: SQL[] = [eq(inventoryTransactions.companyId, ctx.companyId)];
      if (storeId != null)
        conds.push(eq(inventoryTransactions.storeId, storeId));
      if (query.itemId) conds.push(eq(inventoryTransactions.itemId, query.itemId));
      if (query.type)
        conds.push(eq(inventoryTransactions.type, query.type));

      const where = and(...conds);
      const data = await tx
        .select()
        .from(inventoryTransactions)
        .where(where)
        .orderBy(desc(inventoryTransactions.createdAt))
        .limit(limit)
        .offset(offset);
      const [{ count }] = await tx
        .select({ count: sql<number>`count(*)` })
        .from(inventoryTransactions)
        .where(where);
      return { data, total: Number(count), limit, offset };
    });
  }
}
