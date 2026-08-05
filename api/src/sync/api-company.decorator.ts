import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/** The company id resolved from the X-Api-Key header by ApiKeyGuard. */
export const ApiCompany = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): number => {
    return ctx.switchToHttp().getRequest<{ apiCompanyId: number }>()
      .apiCompanyId;
  },
);

/**
 * WHICH key the caller presented, resolved by ApiKeyGuard. Audit events attribute agent
 * writes to the key, so a revoked one stays traceable.
 */
export const ApiKeyId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): number | null => {
    return ctx.switchToHttp().getRequest<{ apiKeyId?: number }>().apiKeyId ?? null;
  },
);
