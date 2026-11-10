import {
  Controller,
  Get,
  Post,
  Delete,
  Inject,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Req,
  Res,
  UnauthorizedException,
  NotFoundException,
  ForbiddenException,
  HttpException,
} from "@nestjs/common";
import type { FastifyRequest, FastifyReply } from "fastify";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { decodeJwt } from "jose";
import { sendNativeVideo } from "../browser-execution/media-stream-response.js";
import { CurrentPrincipal } from "./current-principal.decorator.js";
import type { Principal } from "./auth.types.js";
import { Public } from "./auth.guard.js";
import { Database } from "../infrastructure/database.js";
import { BrowserDashboardRepository } from "../browser-execution/repositories/browser-dashboard.repository.js";

const digest = (v: string) => createHash("sha256").update(v).digest("hex");
const cookieName = "scry_media";
type Grant = {
  id: string;
  secret_hash: string;
  run_id: string;
  media_index: number;
  artifact_digest: string;
  user_id: string | null;
  workspace_id: string | null;
  source_kind: string;
  source_id: string | null;
  source_hash: string | null;
  expires_at: Date;
};

@Controller("api")
export class MediaPlaybackController {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(BrowserDashboardRepository) private readonly dashboard: BrowserDashboardRepository,
  ) {}
  private expiry(principal: Principal, request: FastifyRequest) {
    let expires = Date.now() + 120000;
    if (principal.kind === "user" && (principal.credentialKind ?? "user") === "user") {
      try {
        const exp = decodeJwt((request.headers.authorization ?? "").replace(/^Bearer\s+/i, "")).exp;
        if (typeof exp !== "number") throw Error();
        expires = Math.min(expires, exp * 1000);
      } catch {
        throw new UnauthorizedException("Playback requires an expiring signed-in session.");
      }
    }
    if (expires <= Date.now()) throw new UnauthorizedException("Playback session expired.");
    return expires;
  }
  @Post("runs/:runId/media/:index/playback")
  async mint(
    @CurrentPrincipal() principal: Principal,
    @Param("runId", new ParseUUIDPipe()) runId: string,
    @Param("index", ParseIntPipe) index: number,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const media = await this.dashboard.mediaForStreaming(
      principal.kind === "user" ? principal.workspaceId : undefined,
      runId,
      index,
    );
    const id = randomUUID(),
      secret = randomBytes(32).toString("base64url"),
      path = `/api/media-playback/${id}`;
    const authorization = request.headers.authorization ?? "",
      bearer = authorization.replace(/^Bearer\s+/i, "");
    const expires = this.expiry(principal, request);
    const source =
      principal.kind === "service"
        ? "service"
        : principal.oauthConnectionId
          ? "oauth"
          : principal.mcpTokenId
            ? "mcp"
            : "user";
    if (expires <= Date.now()) throw new UnauthorizedException("Playback session expired.");
    await this.db.boundedTransaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "playback:" + (principal.kind === "user" ? principal.userId : "service"),
      ]);
      await c.query(
        "DELETE FROM media_playback_grants WHERE expires_at<now()-interval '5 minutes'",
      );
      const count = await c.query(
        "SELECT count(*)::int AS n FROM media_playback_grants WHERE user_id IS NOT DISTINCT FROM $1::uuid AND expires_at>now() AND revoked_at IS NULL",
        [principal.kind === "user" ? principal.userId : null],
      );
      if (count.rows[0].n >= 20) {
        reply.header("Retry-After", "120");
        throw new HttpException(
          "Playback sessions are temporarily full. Wait up to two minutes, then select the recording again.",
          429,
        );
      }
      await c.query(
        "INSERT INTO media_playback_grants(id,secret_hash,run_id,media_index,artifact_digest,user_id,workspace_id,source_kind,source_id,source_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
        [
          id,
          digest(secret),
          runId,
          index,
          media.receipt.digest,
          principal.kind === "user" ? principal.userId : null,
          principal.kind === "user" ? principal.workspaceId : null,
          source,
          principal.kind === "user"
            ? (principal.oauthConnectionId ?? principal.mcpTokenId ?? null)
            : null,
          source === "service" ? digest(bearer) : null,
          new Date(expires),
        ],
      );
    }, 3000);
    // The URL contains only a non-secret identity. Its short-lived secret is
    // HttpOnly, path scoped and never returned to JavaScript or a query log.
    reply.header(
      "Set-Cookie",
      `${cookieName}=${secret}; Path=${path}; HttpOnly; SameSite=Strict; Max-Age=${Math.max(1, Math.floor((expires - Date.now()) / 1000))}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`,
    );
    reply.header("Cache-Control", "private, no-store").header("Referrer-Policy", "no-referrer");
    return { id, path: `/media-playback/${id}`, expiresAt: new Date(expires).toISOString() };
  }
  @Post("media-playback/:id/renew")
  async renew(
    @CurrentPrincipal() principal: Principal,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const grant = await this.authorized(id, request.headers.cookie, true);
    if (
      grant.user_id !== (principal.kind === "user" ? principal.userId : null) ||
      grant.workspace_id !== (principal.kind === "user" ? principal.workspaceId : null)
    )
      throw new ForbiddenException("Playback session belongs to another scope.");
    const expires = this.expiry(principal, request);
    const updated = await this.db.query(
      "UPDATE media_playback_grants SET expires_at=$2 WHERE id=$1 AND revoked_at IS NULL AND expires_at>now() RETURNING id",
      [id, new Date(expires)],
    );
    if (!updated.rowCount)
      throw new ForbiddenException(
        "Playback session expired or revoked. Select the recording again.",
      );
    const secret = request.headers
      .cookie!.split(";")
      .map((p) => p.trim())
      .find((p) => p.startsWith(cookieName + "="))!
      .slice(cookieName.length + 1);
    reply
      .header(
        "Set-Cookie",
        `${cookieName}=${secret}; Path=/api/media-playback/${id}; HttpOnly; SameSite=Strict; Max-Age=${Math.max(1, Math.floor((expires - Date.now()) / 1000))}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`,
      )
      .header("Cache-Control", "private, no-store")
      .header("Referrer-Policy", "no-referrer");
    return { id, path: `/media-playback/${id}`, expiresAt: new Date(expires).toISOString() };
  }
  @Delete("media-playback/:id")
  async revoke(
    @CurrentPrincipal() principal: Principal,
    @Param("id", new ParseUUIDPipe()) id: string,
  ) {
    await this.db.query(
      "UPDATE media_playback_grants SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1 AND user_id IS NOT DISTINCT FROM $2::uuid AND workspace_id IS NOT DISTINCT FROM $3::uuid",
      [
        id,
        principal.kind === "user" ? principal.userId : null,
        principal.kind === "user" ? principal.workspaceId : null,
      ],
    );
    return { revoked: true };
  }
  private async authorized(
    id: string,
    cookie: string | undefined,
    accountAuthenticated = false,
  ): Promise<Grant> {
    const denied = (): never => {
      if (accountAuthenticated)
        throw new ForbiddenException(
          "Playback session expired or revoked. Select the recording again.",
        );
      throw new UnauthorizedException("Playback session expired or revoked.");
    };
    const secret = cookie
      ?.split(";")
      .map((p) => p.trim())
      .find((p) => p.startsWith(cookieName + "="))
      ?.slice(cookieName.length + 1);
    if (!secret || !/^[A-Za-z0-9_-]{43}$/.test(secret)) return denied();
    const result = await this.db.boundedTransaction(
      (c) =>
        c.query<Grant>(
          `SELECT g.* FROM media_playback_grants g WHERE g.id=$1 AND g.revoked_at IS NULL AND g.expires_at>now()
      AND (g.source_kind='service' OR EXISTS(SELECT 1 FROM workspace_memberships m WHERE m.user_id=g.user_id AND m.workspace_id=g.workspace_id))
      AND (g.source_kind NOT IN ('oauth','mcp') OR
        (g.source_kind='mcp' AND EXISTS(SELECT 1 FROM mcp_access_tokens t WHERE t.id=g.source_id AND t.user_id=g.user_id AND t.workspace_id=g.workspace_id AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at>now()))) OR
        (g.source_kind='oauth' AND EXISTS(SELECT 1 FROM oauth_connections c JOIN oauth_provider_records p ON p.model='Grant' AND p.id_hash=c.grant_hash WHERE c.id=g.source_id AND c.user_id=g.user_id AND c.workspace_id=g.workspace_id AND c.revoked_at IS NULL AND p.expires_at>now())))`,
          [id],
        ),
      2000,
    );
    const row = result.rows[0];
    if (
      !row ||
      !timingSafeEqual(Buffer.from(row.secret_hash, "hex"), Buffer.from(digest(secret), "hex")) ||
      (row.source_kind === "service" &&
        row.source_hash !== digest(process.env.SCRY_SERVICE_TOKEN ?? ""))
    )
      return denied();
    return row;
  }
  @Public()
  @Get("media-playback/:id")
  async read(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    return this.deliver(id, request, reply);
  }
  private async deliver(id: string, request: FastifyRequest, reply: FastifyReply) {
    reply
      .header("Cache-Control", "private, no-store")
      .header("Referrer-Policy", "no-referrer")
      .header("X-Content-Type-Options", "nosniff");
    const grant = await this.authorized(id, request.headers.cookie);
    const media = await this.dashboard.mediaForStreaming(
      grant.workspace_id ?? undefined,
      grant.run_id,
      grant.media_index,
    );
    if (media.receipt.digest !== grant.artifact_digest)
      throw new NotFoundException("Recording changed. Open it again.");
    return sendNativeVideo(media, request, reply, grant.expires_at);
  }
}
