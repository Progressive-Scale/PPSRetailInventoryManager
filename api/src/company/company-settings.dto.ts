import { IsHexColor, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateBrandingDto {
  // A URL or a data: URL (uploaded logo). Empty string clears it.
  @IsOptional() @IsString() @MaxLength(4_000_000) logoUrl?: string;
  @IsOptional() @IsHexColor() primaryColor?: string;
}
