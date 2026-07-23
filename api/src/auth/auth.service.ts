import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { compare, hash } from 'bcryptjs';
import { and, eq, isNull } from 'drizzle-orm';
import { TenantDbService, Tx } from '../db/tenant-db.service';
import { Company, invitations, User, users } from '../db/schema';
import { HostContext } from '../tenancy/tenant-context';
import { JwtPayload } from './auth.types';

@Injectable()
export class AuthService {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly jwt: JwtService,
  ) {}

  async login(host: HostContext, email: string, password: string) {
    const normalized = email.trim().toLowerCase();

    if (host.kind === 'admin') {
      return this.tenantDb.withBypass(async (tx) => {
        const [u] = await tx
          .select()
          .from(users)
          .where(
            and(
              eq(users.email, normalized),
              eq(users.role, 'PLATFORM_ADMIN'),
              isNull(users.companyId),
            ),
          )
          .limit(1);
        return this.finishLogin(u, password);
      });
    }

    if (host.kind === 'company') {
      return this.tenantDb.withCompany(host.company.id, async (tx) => {
        const [u] = await tx
          .select()
          .from(users)
          .where(eq(users.email, normalized))
          .limit(1);
        return this.finishLogin(u, password);
      });
    }

    throw new UnauthorizedException('Invalid host for login.');
  }

  async acceptInvite(company: Company, token: string, password: string) {
    return this.tenantDb.withCompany(company.id, async (tx) => {
      const [inv] = await tx
        .select()
        .from(invitations)
        .where(eq(invitations.token, token))
        .limit(1);

      if (!inv) throw new NotFoundException('Invalid invitation.');
      if (inv.acceptedAt) throw new BadRequestException('Invitation already used.');
      if (inv.expiresAt.getTime() < Date.now()) {
        throw new BadRequestException('Invitation has expired.');
      }

      let created: User | undefined;
      try {
        [created] = await tx
          .insert(users)
          .values({
            companyId: company.id,
            storeId: inv.storeId,
            email: inv.email.trim().toLowerCase(),
            passwordHash: await hash(password, 10),
            role: inv.role,
            status: 'ACTIVE',
          })
          .returning();
      } catch (err) {
        if (this.isUniqueViolation(err)) {
          throw new BadRequestException('A user with that email already exists.');
        }
        throw err;
      }

      await tx
        .update(invitations)
        .set({ acceptedAt: new Date() })
        .where(eq(invitations.id, inv.id));

      return this.buildResponse(created!, tx);
    });
  }

  private async finishLogin(user: User | undefined, password: string) {
    if (
      !user ||
      user.status !== 'ACTIVE' ||
      !(await compare(password, user.passwordHash))
    ) {
      throw new UnauthorizedException('Invalid credentials');
    }
    return this.buildResponse(user);
  }

  private async buildResponse(user: User, _tx?: Tx) {
    const payload: JwtPayload = {
      sub: user.id,
      companyId: user.companyId,
      storeId: user.storeId,
      role: user.role,
    };
    return {
      access_token: await this.jwt.signAsync(payload),
      user: {
        id: user.id,
        email: user.email,
        companyId: user.companyId,
        storeId: user.storeId,
        role: user.role,
      },
    };
  }

  private isUniqueViolation(err: unknown): boolean {
    return (
      !!err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code?: string }).code === '23505'
    );
  }
}
