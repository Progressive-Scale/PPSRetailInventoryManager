import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class CreateStoreDto {
  @IsString() @MinLength(1) @MaxLength(128) name!: string;
  @IsOptional() @IsString() @MaxLength(256) address1?: string;
  @IsOptional() @IsString() @MaxLength(256) address2?: string;
  @IsOptional() @IsString() @MaxLength(128) city?: string;
  @IsOptional() @IsString() @MaxLength(64) state?: string;
  @IsOptional() @IsString() @MaxLength(32) zip?: string;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class UpdateStoreDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(128) name?: string;
  @IsOptional() @IsString() @MaxLength(256) address1?: string;
  @IsOptional() @IsString() @MaxLength(256) address2?: string;
  @IsOptional() @IsString() @MaxLength(128) city?: string;
  @IsOptional() @IsString() @MaxLength(64) state?: string;
  @IsOptional() @IsString() @MaxLength(32) zip?: string;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

const COMPANY_ROLES = ['COMPANY_ADMIN', 'STORE_USER'] as const;
const USER_STATUSES = ['ACTIVE', 'SUSPENDED'] as const;

export class UpdateUserDto {
  @IsOptional() @IsEnum(COMPANY_ROLES as unknown as string[])
  role?: (typeof COMPANY_ROLES)[number];

  @IsOptional() @IsEnum(USER_STATUSES as unknown as string[])
  status?: (typeof USER_STATUSES)[number];

  /** The user's active store. Must be one of storeIds (or null to clear). */
  @IsOptional() @ValidateIf((o: UpdateUserDto) => o.storeId !== null)
  @IsInt() @IsPositive()
  storeId?: number | null;

  /** Full replacement of the stores this user may access. */
  @IsOptional() @IsArray() @IsInt({ each: true })
  storeIds?: number[];
}

export class CreateInvitationDto {
  @IsEmail() email!: string;

  @IsEnum(COMPANY_ROLES as unknown as string[])
  role!: (typeof COMPANY_ROLES)[number];

  @IsOptional() @IsInt() @IsPositive() storeId?: number;
}
