import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsPositive,
  Max,
  Min,
} from 'class-validator';
import { PaginationQuery } from '../../common/pagination';

const STATUSES = ['UNREAD', 'READ', 'DISMISSED'] as const;
const TYPES = [
  'EXPIRATION_WARNING',
  'INVITE_ACCEPTED',
  'REORDER_ACKNOWLEDGED',
] as const;

export class ListNotificationsQuery extends PaginationQuery {
  @IsOptional()
  @IsEnum(STATUSES as unknown as string[])
  status?: (typeof STATUSES)[number];

  @IsOptional() @IsEnum(TYPES as unknown as string[])
  type?: (typeof TYPES)[number];

  @IsOptional() @Type(() => Number) @IsInt() @IsPositive() storeId?: number;
}

/** Ids to remove from the history. Scoped to the caller's company/store. */
export class DeleteNotificationsDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(500)
  @IsInt({ each: true })
  @IsPositive({ each: true })
  ids!: number[];
}

export class UpdateNotificationDto {
  @IsEnum(STATUSES as unknown as string[])
  status!: (typeof STATUSES)[number];
}

/** Apply one status to many notifications. Scoped like DeleteNotificationsDto. */
export class BulkStatusDto extends DeleteNotificationsDto {
  @IsEnum(STATUSES as unknown as string[])
  status!: (typeof STATUSES)[number];
}

// Upsert notification settings. storeId omitted / null => the company default;
// a storeId sets a per-store override.
export class NotificationSettingsDto {
  @IsOptional() @IsInt() @IsPositive() storeId?: number;
  @IsInt() @Min(1) @Max(3650) expirationAlertDays!: number;
  @IsBoolean() enabled!: boolean;
}
