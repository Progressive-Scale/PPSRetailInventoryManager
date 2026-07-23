import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/** The company id resolved from the X-Api-Key header by ApiKeyGuard. */
export const ApiCompany = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): number => {
    return ctx.switchToHttp().getRequest<{ apiCompanyId: number }>()
      .apiCompanyId;
  },
);
