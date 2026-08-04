import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { PaginationQuery } from '../../common/pagination';

const STATUSES = ['OPEN', 'ACKNOWLEDGED', 'CANCELLED'] as const;

export class CreateReorderDto {
  @Type(() => Number) @IsInt() @IsPositive() productId!: number;

  /**
   * Optional on purpose: a store user often knows the shelf is empty without knowing
   * a case quantity. Consumers read a missing quantity as 1.
   */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) quantity?: number;

  @IsOptional() @IsString() @MaxLength(500) note?: string;

  /**
   * Required for a COMPANY_ADMIN, who has no single store to infer. A STORE_USER's
   * own store always wins over whatever is sent here — see the service.
   */
  @IsOptional() @Type(() => Number) @IsInt() @IsPositive() storeId?: number;
}

export class ListReordersQuery extends PaginationQuery {
  @IsOptional() @IsEnum(STATUSES as unknown as string[])
  status?: (typeof STATUSES)[number];

  @IsOptional() @Type(() => Number) @IsInt() @IsPositive() storeId?: number;

  /**
   * Narrow to one product. The reorder dialog uses this to answer "is there already a
   * live request for this?" exactly, rather than paging the whole list and hoping the
   * answer is on the first page.
   */
  @IsOptional() @Type(() => Number) @IsInt() @IsPositive() productId?: number;
}
