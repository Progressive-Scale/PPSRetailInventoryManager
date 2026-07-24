import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const toBool = ({ value }: { value: unknown }) =>
  value === true || value === 'true';

export class CreateProductDto {
  @IsString() @MinLength(1) @MaxLength(128) sku!: string;
  @IsString() @MinLength(1) @MaxLength(256) name!: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) price?: number;
  @IsOptional() @IsString() @MaxLength(128) upc?: string;
}

export class UpdateProductDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(128) sku?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(256) name?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) price?: number;
  @IsOptional() @IsString() @MaxLength(128) upc?: string;
  @IsOptional() @Transform(toBool) @IsBoolean() active?: boolean;
}

export class ListProductsQuery {
  @IsOptional() @Transform(toBool) @IsBoolean() active?: boolean;
}
