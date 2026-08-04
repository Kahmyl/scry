import { createParamDecorator, type ExecutionContext, UnauthorizedException } from "@nestjs/common";

import type { AuthenticatedRequest, Principal } from "./auth.types.js";

export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Principal => {
    const principal = context.switchToHttp().getRequest<AuthenticatedRequest>().principal;
    if (!principal) throw new UnauthorizedException("No authenticated principal");
    return principal;
  },
);
