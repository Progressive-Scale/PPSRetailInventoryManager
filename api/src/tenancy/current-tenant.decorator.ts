import {
  BadRequestException,
  createParamDecorator,
  ExecutionContext,
} from '@nestjs/common';
import { Company } from '../db/schema';
import { HostContext } from './tenant-context';

/** Full host context (company | admin | unknown). */
export const Tenant = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): HostContext => {
    const req = ctx.switchToHttp().getRequest<{ tenant?: HostContext }>();
    return req.tenant ?? { kind: 'unknown' };
  },
);

/** The resolved company, or 400 if the route wasn't reached on a company host. */
export const CurrentCompany = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Company => {
    const req = ctx.switchToHttp().getRequest<{ tenant?: HostContext }>();
    const t = req.tenant;
    if (!t || t.kind !== 'company') {
      throw new BadRequestException('This endpoint requires a company host.');
    }
    return t.company;
  },
);
