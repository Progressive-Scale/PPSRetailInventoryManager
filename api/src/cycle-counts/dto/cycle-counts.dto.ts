import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsISO8601,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PaginationQuery } from '../../common/pagination';

export class OpenCycleCountDto {
  // Required for COMPANY_ADMIN; ignored for STORE_USER (uses their store).
  @IsOptional() @IsInt() @IsPositive() storeId?: number;
}

// A physical count of a QUANTITY product. Identify by productId or upc.
export class QuantityCountDto {
  @IsOptional() @IsInt() @IsPositive() productId?: number;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(128) upc?: string;
  @IsInt() @Min(0) countedQuantity!: number;
}

// An item scanned during the count that isn't in the catalog yet. Creates a
// needs-review product. isUpc=false -> serialized unit; isUpc=true -> quantity
// stock (requires `quantity`).
export class NewItemDto {
  @IsString() @MinLength(1) @MaxLength(128) serialOrUpc!: string;
  @IsString() @MinLength(1) @MaxLength(256) name!: string;
  @IsBoolean() isUpc!: boolean;
  @IsOptional() @IsInt() @IsPositive() quantity?: number;
  @IsOptional() @IsISO8601() expirationDate?: string;
}

export class CloseCycleCountDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  scannedSerials?: string[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => QuantityCountDto)
  quantityCounts?: QuantityCountDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => NewItemDto)
  newItems?: NewItemDto[];
}

export class ListCycleCountsQuery extends PaginationQuery {
  @IsOptional() @IsInt() @IsPositive() storeId?: number;
}
