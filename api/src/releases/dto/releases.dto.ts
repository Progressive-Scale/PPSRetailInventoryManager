import { Transform, Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * `?current=` is what the device is running. Optional because a caller that omits
 * it simply gets the latest release described without an up-to-date verdict.
 */
export class AppVersionQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  current?: number;
}

/**
 * A release row. The file itself is published out of band (see docs/RELEASES.md);
 * this records where it landed and what it must hash to.
 *
 * Both patterns are enforced again by CHECK constraints. Validating here as well
 * is what turns "the database refused your insert" into a message naming the field.
 */
export class CreateReleaseDto {
  @Type(() => Number) @IsInt() @Min(1) versionCode!: number;

  @IsString() @MinLength(1) @MaxLength(40) versionName!: string;

  // Spelled out rather than via IsUrl, because the SCHEME is the point. https was
  // the only accepted value until the APK host's certificate expired; http is allowed
  // alongside it temporarily. See migration 0041 for the reasoning and the revert.
  @IsString()
  @Matches(/^https?:\/\/[^\s]+$/, {
    message: 'apkUrl must be an http:// or https:// URL.',
  })
  @MaxLength(500)
  apkUrl!: string;

  // Normalised before validation, so a hash pasted from a tool that prints
  // uppercase is accepted rather than rejected for a difference that is not one.
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsString()
  @Matches(/^[0-9a-f]{64}$/, {
    message: 'apkSha256 must be 64 hexadecimal characters.',
  })
  apkSha256!: string;

  @IsOptional() @IsString() @MaxLength(4000) releaseNotes?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0) fileSizeBytes?: number;
}

/**
 * Repoint a channel. Both fields accept null to clear the pointer; a field left
 * out entirely is left alone, which is what makes "set the floor without touching
 * the current release" a single call.
 */
export class UpdateChannelDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  releaseId?: number | null;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  minSupportedReleaseId?: number | null;
}
