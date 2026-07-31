import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Sign in with either a username or an email address.
 *
 * `identifier` is the field to send. `email` is kept as an accepted alias so a
 * scanner build already in the field, which only knows how to send `email`, keeps
 * working. It is no longer validated as an email, because that same field now
 * carries usernames from those older clients too — the service decides how to
 * look the value up by whether it contains '@'.
 */
export class LoginDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(320)
  identifier?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(320)
  email?: string;

  @IsString()
  @IsNotEmpty()
  password!: string;
}
