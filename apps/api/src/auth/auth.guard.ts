import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
  ForbiddenException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";

import { AuthService } from "./auth.service.js";
import type { AuthenticatedRequest } from "./auth.types.js";

const PUBLIC_ROUTE = "scry:public-route";
export const Public = () => SetMetadata(PUBLIC_ROUTE, true);
const TESTING_OPERATIONS = "scry:testing-operations";
/** Unsafe methods in a testing controller require a workspace writer. */
export const TestingOperations = () => SetMetadata(TESTING_OPERATIONS, true);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext) {
    if (
      this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [
        context.getHandler(),
        context.getClass(),
      ])
    ) {
      return true;
    }
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const rawAuthorization = request.headers.authorization;
    const authorization = Array.isArray(rawAuthorization) ? rawAuthorization[0] : rawAuthorization;
    request.principal = await this.auth.authenticate(authorization);
    if (
      this.reflector.getAllAndOverride<boolean>(TESTING_OPERATIONS, [
        context.getHandler(),
        context.getClass(),
      ]) &&
      request.principal.kind === "user" &&
      request.principal.role === "viewer" &&
      !["GET", "HEAD", "OPTIONS"].includes(request.method ?? "")
    )
      throw new ForbiddenException("Workspace viewer access is read-only.");
    return true;
  }
}
