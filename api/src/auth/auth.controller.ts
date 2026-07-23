import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { AcceptInviteDto } from './dto/accept-invite.dto';
import { CurrentCompany, Tenant } from '../tenancy/current-tenant.decorator';
import { HostContext } from '../tenancy/tenant-context';
import { Company } from '../db/schema';

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
  acceptInvite(@CurrentCompany() company: Company, @Body() dto: AcceptInviteDto) {
    return this.auth.acceptInvite(company, dto.token, dto.password);
  }
}
