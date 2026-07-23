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
    const user = ctx.switchToHttp().getRequest<{ user: AuthUser }>().user;
    if (!user || user.companyId == null) {
      throw new BadRequestException('Missing company context.');
    }
    return {
      companyId: user.companyId,
      storeId: user.storeId,
      role: user.role,
      userId: user.userId,
    };
  },
);
