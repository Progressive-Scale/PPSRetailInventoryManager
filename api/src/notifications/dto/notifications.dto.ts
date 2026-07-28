import { Type } from 'class-transformer';
import {
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

export class ListNotificationsQuery extends PaginationQuery {
  @IsOptional()
  @IsEnum(STATUSES as unknown as string[])
  status?: (typeof STATUSES)[number];

  @IsOptional() @Type(() => Number) @IsInt() @IsPositive() storeId?: number;
}

export class UpdateNotificationDto {
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
