import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class ForgotPasswordDto {
  /**
   * Validated as an email, unlike login's identifier: a reset can only be sent to
   * an address, so a username here is a mistake worth naming.
   */
  @IsEmail({}, { message: 'Enter a valid email address.' })
  @MaxLength(320)
  email!: string;
}

export class ResetPasswordDto {
  @IsString()
  @MinLength(1)
  token!: string;

  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters.' })
  @MaxLength(256)
  newPassword!: string;
}

/** Query for the pre-flight check the reset page makes on load. */
export class ResetStatusQuery {
  @IsString()
  @MinLength(8)
  @MaxLength(256)
  token!: string;
}
