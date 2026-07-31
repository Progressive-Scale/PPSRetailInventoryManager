import { IsString, Matches, MaxLength, MinLength } from 'class-validator';
import {
  USERNAME_INPUT_PATTERN,
  USERNAME_MAX,
  USERNAME_RULE,
} from '../username.util';

export class AcceptInviteDto {
  @IsString()
  @MinLength(1)
  token!: string;

  /**
   * The sign-in name the invitee chooses. Uppercase is allowed here and folded to
   * lowercase by the service, so "Alice" is accepted and stored as "alice".
   */
  // The pattern is anchored and bounded, so it already enforces the 3–32 length —
  // a separate MinLength would only repeat the same message. MaxLength stays as a
  // cheap guard so an absurd payload is rejected before the regex runs.
  @IsString()
  @MaxLength(USERNAME_MAX, { message: USERNAME_RULE })
  @Matches(USERNAME_INPUT_PATTERN, { message: USERNAME_RULE })
  username!: string;

  @IsString()
  @MinLength(8)
  password!: string;
}
