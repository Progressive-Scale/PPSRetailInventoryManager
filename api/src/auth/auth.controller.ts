import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsInt, IsPositive } from 'class-validator';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { AcceptInviteDto } from './dto/accept-invite.dto';
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
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Tenant() host: HostContext, @Body() dto: LoginDto) {
    return this.auth.login(host, dto.email, dto.password);
  }

  @Post('accept-invite')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  acceptInvite(@CurrentCompany() company: Company, @Body() dto: AcceptInviteDto) {
    return this.auth.acceptInvite(company, dto.token, dto.password);
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
