import { IsString, Matches, MaxLength, MinLength } from 'class-validator';
import {
  USERNAME_INPUT_PATTERN,
  USERNAME_MAX,
  USERNAME_RULE,
} from '../username.util';

export class ChangeUsernameDto {
  // The pattern is anchored and bounded, so it already enforces 3–32; MaxLength is
  // only here to reject an absurd payload before the regex runs.
  @IsString()
  @MaxLength(USERNAME_MAX, { message: USERNAME_RULE })
  @Matches(USERNAME_INPUT_PATTERN, { message: USERNAME_RULE })
  username!: string;
}

export class ChangePasswordDto {
  /**
   * Proves the person at the keyboard is the account holder and not someone who
   * walked up to an unlocked session. Required even though the request is already
   * authenticated.
   */
  @IsString()
  @MinLength(1)
  currentPassword!: string;

  @IsString()
  @MinLength(8, { message: 'New password must be at least 8 characters.' })
  @MaxLength(256)
  newPassword!: string;
}
