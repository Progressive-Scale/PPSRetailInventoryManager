import {
  Controller,
  ForbiddenException,
  Get,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsDate,
  IsEnum,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
} from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { Ctx } from '../auth/current-user.decorator';
import {
  DataContext,
  isStoreScoped,
  TENANT_USER_ROLES,
} from '../auth/auth.types';
import { Paginated, PaginationQuery, resolvePaging } from '../common/pagination';
import { ActivityRow, ActivityService, ActivitySource } from './activity.service';

const SOURCES = ['WEB', 'SCANNER', 'SYNC', 'JOB'] as const;

/** The entities a store user may read the history of — the stock they handle, not the staff. */
const STORE_USER_ENTITIES = new Set([
  'INVENTORY_ITEM',
  'PRODUCT',
  'LOCATION',
  'CYCLE_COUNT',
  'REORDER',
]);

class ActivityQuery extends PaginationQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  userId?: number;

  @IsOptional()
  @IsString()
  entityType?: string;

  @IsOptional()
  @IsString()
  action?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  storeId?: number;

  // Actor, store, product, serial, or the action itself. Bounded: it reaches an ILIKE.
  @IsOptional()
  @IsString()
  @MaxLength(128)
  search?: string;

  @IsOptional()
  @IsEnum(SOURCES as unknown as string[])
  source?: ActivitySource;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;
}

/**
 * The unified activity stream.
 *
 * Two shapes on purpose:
 *   GET /api/activity                          — the whole company's stream (admins)
 *   GET /api/activity/:entityType/:entityId    — one thing's history (anyone who can see it)
 *
 * The split is the permission boundary. "What has everyone been doing" is management
 * information and belongs to a company admin; "what happened to this item" is part of
 * reading the item, so a store user keeps it — otherwise the history sections on detail
 * views would be admin-only and the shop floor loses the answer to "why does this say 3".
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('activity')
export class ActivityController {
  constructor(private readonly activity: ActivityService) {}

  @Get()
  @Roles(['COMPANY_ADMIN'])
  list(
    @Ctx() ctx: DataContext,
    @Query() query: ActivityQuery,
  ): Promise<Paginated<ActivityRow>> {
    return this.activity.list(
      ctx.companyId,
      {
        userId: query.userId,
        entityType: query.entityType,
        action: query.action,
        storeId: query.storeId,
        // Global feed only — one entity's own history is already narrowed to it.
        search: query.search,
        source: query.source,
        from: query.from,
        to: query.to,
      },
      resolvePaging(query),
    );
  }

  /**
   * One entity's history, newest first. For an inventory item this is the ledger and the
   * field edits interleaved, which is the whole point of the union.
   */
  @Get(':entityType/:entityId')
  @Roles(TENANT_USER_ROLES)
  entity(
    @Ctx() ctx: DataContext,
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @Query() query: ActivityQuery,
  ): Promise<Paginated<ActivityRow>> {
    const type = entityType.toUpperCase();
    const storeUser = isStoreScoped(ctx.role);

    // A store user gets the history of the things they work with. People-management
    // history — who changed whose role, who was invited — is management information, and
    // handing it out through a guessable id would undo the admin-only global stream.
    if (storeUser && !STORE_USER_ENTITIES.has(type)) {
      throw new ForbiddenException('Not available for your role.');
    }
    const storeId = storeUser ? (ctx.storeId ?? undefined) : query.storeId;
    if (storeUser && storeId == null) {
      throw new ForbiddenException('No store is selected for this session.');
    }
    return this.activity.list(
      ctx.companyId,
      {
        entityType: type,
        entityId,
        userId: query.userId,
        action: query.action,
        storeId,
        // Catalog edits carry no store, and they are exactly what a store user is looking
        // at when they open a product's history.
        includeCompanyWide: storeUser,
        source: query.source,
        from: query.from,
        to: query.to,
      },
      resolvePaging(query),
    );
  }
}
