import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
  Req,
  Res,
  BadRequestException,
  ForbiddenException,
} from "@nestjs/common";
import type { FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { Public } from "../auth.guard.js";
import { CurrentPrincipal } from "../current-principal.decorator.js";
import type { Principal } from "../auth.types.js";
import { OAuthService } from "./oauth.service.js";
import { ConnectionsRepository, requireDashboardUser } from "./connections.repository.js";
import { testingScope } from "./config.js";

@Controller("api/integrations")
export class ConnectionsController {
  constructor(
    @Inject(OAuthService) private readonly oauth: OAuthService,
    @Inject(ConnectionsRepository) private readonly connections: ConnectionsRepository,
  ) {}

  @Get("session")
  session(@CurrentPrincipal() principal: Principal) {
    if (principal.kind === "service")
      return {
        subject: principal.subject,
        workspaceId: "service",
        credentialId: "service",
        credentialKind: "service",
      };
    return {
      subject: principal.userId,
      workspaceId: principal.workspaceId,
      credentialId: principal.oauthConnectionId ?? principal.mcpTokenId ?? "dashboard",
      credentialKind: principal.credentialKind ?? "user",
    };
  }

  @Get("connections")
  async list(@CurrentPrincipal() principal: Principal) {
    requireDashboardUser(principal);
    if (!this.oauth.provider) return { available: false, connections: [] };
    return { available: true, connections: await this.connections.list(principal) };
  }

  @Delete("connections/:id")
  revoke(@CurrentPrincipal() principal: Principal, @Param("id") id: string) {
    if (!z.uuid().safeParse(id).success) throw new BadRequestException("Connection not found.");
    return this.connections.revoke(principal, id);
  }

  @Public()
  @Get("authorize/:uid")
  begin(@Param("uid") uid: string, @Res() reply: FastifyReply) {
    const { config } = this.oauth.require();
    if (!/^[A-Za-z0-9_-]{10,128}$/u.test(uid))
      throw new BadRequestException("Start the connection again from your AI client.");
    reply.header("Cache-Control", "no-store").header("Referrer-Policy", "no-referrer");
    return reply.redirect(`${config.webOrigin}/connect/authorize/${uid}`);
  }

  private async interaction(
    principal: Principal,
    uid: string,
    request: FastifyRequest,
    reply: FastifyReply,
  ) {
    requireDashboardUser(principal);
    const { provider, config } = this.oauth.require();
    let details;
    try {
      details = await provider.interactionDetails(request.raw, reply.raw);
    } catch {
      throw new BadRequestException(
        "This connection request expired. Start again from your AI client.",
      );
    }
    if (details.uid !== uid)
      throw new ForbiddenException("This request belongs to a different connection.");
    const scope = String(details.params.scope ?? "")
      .split(" ")
      .filter(Boolean);
    const resources = details.params.resource;
    if (
      !scope.includes(testingScope) ||
      scope.some((item) => ![testingScope, "openid", "offline_access"].includes(item)) ||
      (resources &&
        resources !== config.resource &&
        !(Array.isArray(resources) && resources.length === 1 && resources[0] === config.resource))
    )
      throw new BadRequestException("This client requested unsupported access.");
    return { details, provider, config };
  }

  @Get("authorize/:uid/details")
  async details(
    @CurrentPrincipal() principal: Principal,
    @Param("uid") uid: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { details, provider } = await this.interaction(principal, uid, request, reply);
    const client = await provider.Client.find(String(details.params.client_id));
    reply.header("Cache-Control", "no-store").header("Referrer-Policy", "no-referrer");
    return {
      clientName: client?.clientName ?? "AI client",
      callbackOrigin: new URL(String(details.params.redirect_uri)).origin,
      permissions: [
        "Run browser tests and read reports and evidence within your workspace permissions",
      ],
      workspaces: await this.connections.workspaces(principal),
    };
  }

  @Post("authorize/:uid/decision")
  async decision(
    @CurrentPrincipal() principal: Principal,
    @Param("uid") uid: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { details, provider, config } = await this.interaction(principal, uid, request, reply);
    if (request.headers.origin !== config.webOrigin)
      throw new ForbiddenException("Return to Scry to approve this connection.");
    const parsed = z
      .discriminatedUnion("decision", [
        z.object({ decision: z.literal("deny") }),
        z.object({ decision: z.literal("approve"), workspaceId: z.uuid() }),
      ])
      .safeParse(body);
    if (!parsed.success)
      throw new BadRequestException("Choose a workspace and approve or cancel this connection.");
    reply.header("Cache-Control", "no-store").header("Referrer-Policy", "no-referrer");
    if (parsed.data.decision === "deny")
      return {
        redirectTo: await provider.interactionResult(
          request.raw,
          reply.raw,
          { error: "access_denied", error_description: "The user cancelled this connection." },
          { mergeWithLastSubmission: false },
        ),
      };
    const user = requireDashboardUser(principal);
    const clientId = String(details.params.client_id);
    const client = await provider.Client.find(clientId);
    const grant = new provider.Grant({ accountId: user.userId, clientId });
    grant.addResourceScope(config.resource, testingScope);
    // The provider also tracks advertised scopes for consent bookkeeping.
    // These exact scopes were allowlisted by interaction() above; the testing
    // access token still requires the separate resource grant and workspace.
    grant.addOIDCScope(String(details.params.scope));
    const grantId = await grant.save();
    try {
      await this.connections.approve(principal, {
        workspaceId: parsed.data.workspaceId,
        clientId,
        clientName: client?.clientName ?? "AI client",
        grantId,
      });
      return {
        redirectTo: await provider.interactionResult(
          request.raw,
          reply.raw,
          { login: { accountId: user.userId, remember: false }, consent: { grantId } },
          { mergeWithLastSubmission: false },
        ),
      };
    } catch (error) {
      // Approval and the browser redirect are separate durable steps. An
      // interrupted handoff must not leave a usable grant behind.
      await this.oauth.discardGrant(grantId);
      throw error;
    }
  }
}
