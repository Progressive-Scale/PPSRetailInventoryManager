import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from './jwt-auth.guard';
import { CurrentUser } from './current-user.decorator';
import { AuthUser } from './auth.types';
import { ProfileService } from './profile.service';
import { ChangePasswordDto, ChangeUsernameDto } from './dto/profile.dto';

/**
 * Your own account. Every route acts on the caller's user id from the token, so
 * there is no id in any path — a user cannot address anybody else's record here.
 * Deliberately not role-gated: a platform admin should be able to change their own
 * password just like everyone else.
 */
@UseGuards(JwtAuthGuard)
@Controller('profile')
export class ProfileController {
  constructor(private readonly profile: ProfileService) {}

  @Get()
  me(@CurrentUser() user: AuthUser) {
    return this.profile.me(user);
  }

  @Patch('username')
  @HttpCode(HttpStatus.OK)
  changeUsername(@CurrentUser() user: AuthUser, @Body() dto: ChangeUsernameDto) {
    return this.profile.changeUsername(user, dto.username);
  }

  // Rate-limited because it takes the current password: this is the one
  // authenticated route where guessing gains an attacker something.
  @Patch('password')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  changePassword(@CurrentUser() user: AuthUser, @Body() dto: ChangePasswordDto) {
    return this.profile.changePassword(user, dto.currentPassword, dto.newPassword);
  }
}
