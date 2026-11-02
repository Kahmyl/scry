import {
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { createHash, timingSafeEqual } from "node:crypto";

import type { Principal } from "./auth.types.js";
import { IdentityRepository } from "./repositories/identity.repository.js";
import { OAuthService } from "./oauth/oauth.service.js";

@Injectable()
export class AuthService {
  private readonly supabaseUrl = normalizedUrl(process.env.SUPABASE_URL);
  private readonly issuer = this.supabaseUrl ? `${this.supabaseUrl}/auth/v1` : undefined;
  private readonly jwks = this.issuer
    ? createRemoteJWKSet(new URL(`${this.issuer}/.well-known/jwks.json`))
    : undefined;

  constructor(
    @Inject(IdentityRepository) private readonly identities: IdentityRepository,
    @Optional() @Inject(OAuthService) private readonly oauth?: OAuthService,
  ) {}

  async authenticate(authorization: string | undefined): Promise<Principal> {
    const token = bearerToken(authorization);
    if (!token) throw new UnauthorizedException("A bearer access token is required");

    const serviceToken = process.env.SCRY_SERVICE_TOKEN;
    if (serviceToken && secureEqual(token, serviceToken)) {
      return { kind: "service", credentialKind: "service", subject: "scry-service" };
    }

    if (token.startsWith("scry_mcp_")) {
      const principal = await this.identities.principalForMcpToken(
        createHash("sha256").update(token).digest("hex"),
      );
      if (principal) return { ...principal, credentialKind: "mcp" };
      throw new UnauthorizedException("The MCP access token is invalid, expired, or revoked");
    }

    if (this.oauth?.provider && !token.includes(".")) {
      const principal = await this.oauth.authenticate(token);
      if (principal) return principal;
      throw new UnauthorizedException("Reconnect Scry to continue.");
    }
    if (!this.jwks || !this.issuer) {
      throw new ServiceUnavailableException("Supabase authentication is not configured on the API");
    }

    try {
      const { payload } = await jwtVerify(token, this.jwks, {
        issuer: this.issuer,
        audience: "authenticated",
      });
      if (!payload.sub || typeof payload.email !== "string" || payload.client_id !== undefined) {
        throw new UnauthorizedException("The access token is missing required identity claims");
      }
      return {
        ...(await this.identities.provisionUser(payload.sub, payload.email)),
        credentialKind: "user",
      };
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw new UnauthorizedException("The access token is invalid or expired");
    }
  }
}

function bearerToken(value: string | undefined) {
  if (!value) return undefined;
  const [scheme, token, extra] = value.trim().split(/\s+/);
  return scheme?.toLowerCase() === "bearer" && token && !extra ? token : undefined;
}

function normalizedUrl(value: string | undefined) {
  return value?.replace(/\/+$/, "");
}

function secureEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
