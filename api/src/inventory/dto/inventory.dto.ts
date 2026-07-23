import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PaginationQuery } from '../../common/pagination';

const toBool = ({ value }: { value: unknown }) =>
  value === true || value === 'true';

export const ITEM_STATUSES = [
  'ON_HAND',
  'SOLD',
  'RETURNED_TO_WAREHOUSE',
  'ADJUSTED_OUT',
] as const;

export class ListItemsQuery extends PaginationQuery {
  @IsOptional()
  @IsEnum(ITEM_STATUSES as unknown as string[])
  status?: (typeof ITEM_STATUSES)[number];

  // COMPANY_ADMIN may narrow to a store within the company.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  storeId?: number;

  // Review queue for flagged items.
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  needsReview?: boolean;
}

export class CreateItemDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  serial!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  sku!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(256)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  price?: number;

  // Required for COMPANY_ADMIN; ignored for STORE_USER (uses their store).
  @IsOptional()
  @IsInt()
  @IsPositive()
  storeId?: number;
}

export class UpdateItemDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  price?: number;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  upc?: string;

  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  needsReview?: boolean;
}

export class ItemActionDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
