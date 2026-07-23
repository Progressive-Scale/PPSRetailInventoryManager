import {
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateStoreDto {
  @IsString() @MinLength(1) @MaxLength(128) name!: string;
  @IsString() @MinLength(1) @MaxLength(32) code!: string;
  @IsOptional() @IsString() @MaxLength(128) externalBuildingId?: string;
}

export class UpdateStoreDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(128) name?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(32) code?: string;
  @IsOptional() @IsString() @MaxLength(128) externalBuildingId?: string;
}

const COMPANY_ROLES = ['COMPANY_ADMIN', 'STORE_USER'] as const;
const USER_STATUSES = ['ACTIVE', 'SUSPENDED'] as const;

export class UpdateUserDto {
  @IsOptional() @IsEnum(COMPANY_ROLES as unknown as string[])
  role?: (typeof COMPANY_ROLES)[number];

  @IsOptional() @IsEnum(USER_STATUSES as unknown as string[])
  status?: (typeof USER_STATUSES)[number];

  @IsOptional() @IsInt() @IsPositive() storeId?: number;
}

export class CreateInvitationDto {
  @IsEmail() email!: string;

  @IsEnum(COMPANY_ROLES as unknown as string[])
  role!: (typeof COMPANY_ROLES)[number];

  @IsOptional() @IsInt() @IsPositive() storeId?: number;
}
