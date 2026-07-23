import {
  IsEmail,
  IsEnum,
  IsHexColor,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

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
}

export class CreateApiKeyDto {
  @IsString() @MinLength(1) @MaxLength(128) name!: string;
}

export class AdminInviteDto {
  @IsEmail() email!: string;
}
