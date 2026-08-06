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

/**
 * A new store must have somewhere to ship to.
 *
 * address1, city, state and zip are REQUIRED: a store is a delivery destination, and the
 * ERP cannot raise a shipment against a row that has no address. Leaving them optional
 * meant the gap only showed up later, in the one place it cannot be fixed quickly.
 *
 * address2 stays optional — a suite or unit number is genuinely not always there.
 */
export class CreateStoreDto {
  @IsString() @MinLength(1) @MaxLength(128) name!: string;
  @IsString() @MinLength(1) @MaxLength(256) address1!: string;
  @IsOptional() @IsString() @MaxLength(256) address2?: string;
  @IsString() @MinLength(1) @MaxLength(128) city!: string;
  @IsString() @MinLength(1) @MaxLength(64) state!: string;
  @IsString() @MinLength(1) @MaxLength(32) zip!: string;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

/**
 * Every field stays optional, because this is a patch — but the address parts now carry
 * MinLength(1), so an update can no longer blank out an address that a shipment depends
 * on. Omitting a field still leaves it alone; sending "" is now rejected rather than
 * quietly erasing a ship-to.
 */
export class UpdateStoreDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(128) name?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(256) address1?: string;
  @IsOptional() @IsString() @MaxLength(256) address2?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(128) city?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(64) state?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(32) zip?: string;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

const COMPANY_ROLES = [
  'COMPANY_ADMIN',
  'STORE_MANAGER',
  'STORE_USER',
] as const;
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

  /** Single-store form, retained for compatibility; prefer storeIds. */
  @IsOptional() @IsInt() @IsPositive() storeId?: number;

  /** Stores the invitee is granted on accept. */
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @IsPositive({ each: true })
  storeIds?: number[];
}
