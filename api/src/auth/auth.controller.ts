import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsInt, IsPositive } from 'class-validator';
import { AuthService } from './auth.service';
import { PasswordResetService } from './password-reset.service';
import { LoginDto } from './dto/login.dto';
import { AcceptInviteDto } from './dto/accept-invite.dto';
import {
  ForgotPasswordDto,
  ResetPasswordDto,
  ResetStatusQuery,
} from './dto/password-reset.dto';
import { CurrentCompany, Tenant } from '../tenancy/current-tenant.decorator';
import { HostContext } from '../tenancy/tenant-context';
import { Company } from '../db/schema';
import { JwtAuthGuard } from './jwt-auth.guard';
import { CurrentUser } from './current-user.decorator';
import { AuthUser } from './auth.types';

class SelectStoreDto {
  @IsInt() @IsPositive() storeId!: number;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly reset: PasswordResetService,
  ) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Tenant() host: HostContext, @Body() dto: LoginDto) {
    // `email` is the legacy field name; a scanner build already in the field sends
    // whatever was typed in it, username included. Either way the service works out
    // which kind of identifier it received.
    const identifier = dto.identifier ?? dto.email;
    if (!identifier) {
      throw new BadRequestException('A username or email address is required.');
    }
    return this.auth.login(host, identifier, dto.password);
  }

  @Post('accept-invite')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  acceptInvite(@CurrentCompany() company: Company, @Body() dto: AcceptInviteDto) {
    return this.auth.acceptInvite(company, dto.token, dto.username, dto.password);
  }

  /**
   * Ask for a reset link. Rate-limited harder than login: it is unauthenticated,
   * it sends mail, and — because it reports an unknown address — it is the one
   * endpoint that can be used to probe which emails are registered.
   */
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  forgotPassword(@Tenant() host: HostContext, @Body() dto: ForgotPasswordDto) {
    return this.reset.request(host, dto.email);
  }

  /** Lifecycle of a reset token, so the page can explain a dead link before asking. */
  @Get('reset-status')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  resetStatus(@Tenant() host: HostContext, @Query() query: ResetStatusQuery) {
    return this.reset.status(host, query.token);
  }

  /** Redeem a reset link and sign in. */
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  resetPassword(@Tenant() host: HostContext, @Body() dto: ResetPasswordDto) {
    return this.reset.reset(host, dto.token, dto.newPassword);
  }

  /** Stores the signed-in user may access (drives a store switcher). */
  @Get('my-stores')
  @UseGuards(JwtAuthGuard)
  myStores(@CurrentUser() user: AuthUser) {
    return this.auth.myStores(user);
  }

  /** Choose the active store (users permitted several stores pick one at login). */
  @Post('select-store')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  selectStore(@CurrentUser() user: AuthUser, @Body() dto: SelectStoreDto) {
    return this.auth.selectStore(user, dto.storeId);
  }
}
