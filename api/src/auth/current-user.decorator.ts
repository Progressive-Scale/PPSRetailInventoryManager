import {
  BadRequestException,
  createParamDecorator,
  ExecutionContext,
} from '@nestjs/common';
import { AuthUser, DataContext } from './auth.types';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    return ctx.switchToHttp().getRequest<{ user: AuthUser }>().user;
  },
);

/** Tenant data context for a company/store user (throws if not company-scoped). */
export const Ctx = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): DataContext => {
    const req = ctx.switchToHttp().getRequest<{
      user: AuthUser;
      header?: (name: string) => string | undefined;
      headers?: Record<string, string | string[] | undefined>;
    }>();
    const user = req.user;
    if (!user || user.companyId == null) {
      throw new BadRequestException('Missing company context.');
    }
    // Optional and advisory: it only labels the door, never who or what may be done.
    const raw = req.header?.('x-client') ?? req.headers?.['x-client'];
    const client =
      String(Array.isArray(raw) ? raw[0] : (raw ?? '')).toLowerCase() === 'scanner'
        ? ('SCANNER' as const)
        : ('WEB' as const);
    return {
      companyId: user.companyId,
      storeId: user.storeId,
      role: user.role,
      userId: user.userId,
      client,
    };
  },
);
