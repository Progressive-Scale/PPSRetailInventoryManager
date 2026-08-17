import { Type } from 'class-transformer';
import {
  IsArray,
  IsEmail,
  IsEnum,
  IsHexColor,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PaginationQuery } from '../common/pagination';

export class CreateCompanyDto {
  @IsString() @MinLength(1) @MaxLength(128) name!: string;

  // slug: lowercase letters, digits, hyphens.
  @IsString()
  @Matches(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, {
    message: 'slug must be lowercase alphanumeric/hyphen',
  })
  @MaxLength(63)
  slug!: string;

  @IsOptional() @IsString() @MaxLength(255) customDomain?: string;
  @IsOptional() @IsString() @MaxLength(1024) logoUrl?: string;
  @IsOptional() @IsHexColor() primaryColor?: string;
}

export class UpdateCompanyDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(128) name?: string;
  @IsOptional() @IsEnum(['ACTIVE', 'SUSPENDED'] as unknown as string[])
  status?: 'ACTIVE' | 'SUSPENDED';
  @IsOptional() @IsString() @MaxLength(255) customDomain?: string;
  @IsOptional() @IsString() @MaxLength(1024) logoUrl?: string;
  @IsOptional() @IsHexColor() primaryColor?: string;

  /**
   * Which scanner release channel this company's devices follow. Changing it is
   * audited (entity COMPANY, field release_channel) because it decides what
   * software a tenant's staff are running, which is not the platform's private
   * business.
   */
  @IsOptional() @Type(() => Number) @IsInt() @IsPositive()
  releaseChannelId?: number;
}

export class CreateApiKeyDto {
  @IsString() @MinLength(1) @MaxLength(128) name!: string;
}

// ---- cross-company users ---------------------------------------------------

const ALL_ROLES = [
  'PLATFORM_ADMIN',
  'COMPANY_ADMIN',
  'STORE_MANAGER',
  'STORE_USER',
] as const;
const TENANT_ROLES = ['COMPANY_ADMIN', 'STORE_MANAGER', 'STORE_USER'] as const;
const USER_STATUSES = ['ACTIVE', 'SUSPENDED'] as const;

export class AdminUserQuery extends PaginationQuery {
  /** One tenant, or every tenant when omitted. */
  @IsOptional() @Type(() => Number) @IsInt() @IsPositive() companyId?: number;

  @IsOptional() @IsEnum(ALL_ROLES as unknown as string[])
  role?: (typeof ALL_ROLES)[number];

  @IsOptional() @IsEnum(USER_STATUSES as unknown as string[])
  status?: (typeof USER_STATUSES)[number];

  /** Substring of username or email — how you find one person across all tenants. */
  @IsOptional() @IsString() @MaxLength(128) q?: string;
}

/**
 * What a platform admin may change about a tenant user. Deliberately the same
 * fields a company admin can change on their own Manage screen: this exists to do
 * the tenant's job for them, not to reach further than they can.
 */
export class AdminUpdateUserDto {
  @IsOptional() @IsEnum(TENANT_ROLES as unknown as string[])
  role?: (typeof TENANT_ROLES)[number];

  @IsOptional() @IsEnum(USER_STATUSES as unknown as string[])
  status?: (typeof USER_STATUSES)[number];

  /** Full replacement of the stores this user may access. */
  @IsOptional() @IsArray() @IsInt({ each: true }) @IsPositive({ each: true })
  storeIds?: number[];
}

// ---- cross-company invitations ---------------------------------------------

export class AdminCreateInvitationDto {
  @IsEmail() email!: string;

  @IsEnum(TENANT_ROLES as unknown as string[])
  role!: (typeof TENANT_ROLES)[number];

  /** Stores the invitee is granted on accept. Empty for a company admin. */
  @IsOptional() @IsArray() @IsInt({ each: true }) @IsPositive({ each: true })
  storeIds?: number[];
}
