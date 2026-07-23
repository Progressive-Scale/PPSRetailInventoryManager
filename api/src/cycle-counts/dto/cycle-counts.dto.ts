import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsInt,
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

export class UpcCountDto {
  @IsString() @MinLength(1) @MaxLength(128) upc!: string;
  @IsInt() @Min(0) quantity!: number;
}

export class NewItemDto {
  @IsString() @MinLength(1) @MaxLength(128) serialOrUpc!: string;
  @IsString() @MinLength(1) @MaxLength(256) name!: string;
  @IsBoolean() isUpc!: boolean;
}

export class CloseCycleCountDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  scannedSerials?: string[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UpcCountDto)
  upcCounts?: UpcCountDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => NewItemDto)
  newItems?: NewItemDto[];
}

export class ListCycleCountsQuery extends PaginationQuery {
  @IsOptional() @IsInt() @IsPositive() storeId?: number;
}
