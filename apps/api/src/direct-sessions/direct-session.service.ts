import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
  type DirectAction,
  type DirectLocator,
  type ExecuteDirectTurnInput,
  type StartDirectSessionInput,
} from "@scry/contracts";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";

import { decryptCredential, encryptCredential } from "../access/index.js";
import type { Principal } from "../auth/index.js";
import { Database } from "../infrastructure/index.js";

type DirectSession = {
  id: string;
  owner: string;
  projectId: string;
  environmentId: string;
  allowedOrigins: Set<string>;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  busy: boolean;
  lastUsedAt: number;
  secrets: Set<string>;
  transcript: Array<Record<string, unknown>>;
};

const IDLE_TTL_MS = 30 * 60 * 1_000;
const MAX_SESSIONS_PER_OWNER = 3;
const MAX_LANDMARKS = 24;
const MAX_RETURNED_TRANSCRIPT_ENTRIES = 100;

@Injectable()
export class DirectSessionService implements OnModuleDestroy {
  private readonly sessions = new Map<string, DirectSession>();
  private readonly sweeper = setInterval(() => void this.expireIdle(), 30_000).unref();

  constructor(@Inject(Database) private readonly database: Database) {}

  async start(principal: Principal, input: StartDirectSessionInput) {
    this.requireEnabled();
    this.requireWrite(principal);
    const owner = ownerKey(principal);
    if ([...this.sessions.values()].filter((session) => session.owner === owner).length >= MAX_SESSIONS_PER_OWNER)
      throw new ConflictException({ code: "DIRECT_SESSION_LIMIT_REACHED" });
    const environment = await this.loadEnvironment(principal, input);
    const deploymentOrigins = configuredExternalOrigins();
    for (const requested of input.additionalOrigins) {
      if (!deploymentOrigins.has(new URL(requested).origin)) throw new ForbiddenException({ code: "DIRECT_EXTERNAL_ORIGIN_NOT_CONFIGURED" });
    }
    const allowedOrigins = new Set<string>([
      environment.baseOrigin,
      ...environment.policy.allowedOrigins,
      ...input.additionalOrigins.map((value) => new URL(value).origin),
    ]);
    const startUrl = input.startUrl ?? environment.baseOrigin;
    requireAllowedOrigin(startUrl, allowedOrigins);
    const browserChannel = process.env.SCRY_BROWSER_CHANNEL ?? "chrome";
    const browser = await chromium.launch({
      headless: true,
      ...(browserChannel === "chromium" ? {} : { channel: browserChannel }),
    });
    const context = await browser.newContext({ acceptDownloads: false });
    const page = await context.newPage();
    const session: DirectSession = {
      id: randomUUID(), owner, projectId: input.projectId, environmentId: input.environmentId,
      allowedOrigins, browser, context, page, busy: false, lastUsedAt: Date.now(),
      secrets: new Set(), transcript: [],
    };
    this.sessions.set(session.id, session);
    try {
      await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      requireAllowedOrigin(page.url(), allowedOrigins);
      await waitForDocumentSurface(page, 5_000);
      return { sessionId: session.id, state: "active", observation: await this.observePage(session) };
    } catch (error) {
      await this.destroy(session);
      throw directFailure(error);
    }
  }

  async turn(principal: Principal, sessionId: string, input: ExecuteDirectTurnInput) {
    const session = this.requireSession(principal, sessionId);
    if (session.busy) throw new ConflictException({ code: "DIRECT_SESSION_BUSY" });
    session.busy = true;
    session.lastUsedAt = Date.now();
    const startedAt = performance.now();
    const results: Array<Record<string, unknown>> = [];
    try {
      for (let index = 0; index < input.actions.length; index += 1) {
        if (performance.now() - startedAt >= input.timeoutMs) {
          results.push({ index, type: input.actions[index]!.type, status: "failed", dispatchState: "not_started", durationMs: 0, reasonCode: "DIRECT_TURN_TIMEOUT" });
          break;
        }
        const result = await this.executeAction(session, input.actions[index]!, index);
        results.push(result);
        session.transcript.push({ ...sanitizeAction(input.actions[index]!), ...result, occurredAt: new Date().toISOString() });
        if (result.status === "failed") {
          if (result.reasonCode === "DIRECT_ORIGIN_NOT_ALLOWED" || result.reasonCode === "DIRECT_CAPTURE_OUTCOME_UNKNOWN") {
            await this.destroy(session);
            return { sessionId, state: "closed", results, observation: null, durationMs: performance.now() - startedAt };
          }
          break;
        }
      }
      return { sessionId, state: "active", results, observation: await this.observePage(session), durationMs: performance.now() - startedAt };
    } finally {
      session.busy = false;
      session.lastUsedAt = Date.now();
    }
  }

  async observe(principal: Principal, sessionId: string) {
    const session = this.requireSession(principal, sessionId);
    if (session.busy) throw new ConflictException({ code: "DIRECT_SESSION_BUSY" });
    session.lastUsedAt = Date.now();
    return { sessionId, state: "active", observation: await this.observePage(session) };
  }

  async close(principal: Principal, sessionId: string) {
    const session = this.requireSession(principal, sessionId);
    if (session.busy) throw new ConflictException({ code: "DIRECT_SESSION_BUSY" });
    const transcriptEntryCount = session.transcript.length;
    const transcript = session.transcript.slice(-MAX_RETURNED_TRANSCRIPT_ENTRIES);
    await this.destroy(session);
    return { sessionId, state: "closed", transcriptEntryCount, transcriptTruncated: transcriptEntryCount > transcript.length, transcript };
  }

  async onModuleDestroy() {
    clearInterval(this.sweeper);
    await Promise.all([...this.sessions.values()].map((session) => this.destroy(session)));
  }

  private async executeAction(session: DirectSession, action: DirectAction, index: number) {
    const startedAt = performance.now();
    let dispatched = false;
    let resultMetadata: Record<string, unknown> = {};
    try {
      const timeout = "timeoutMs" in action ? action.timeoutMs ?? 10_000 : 10_000;
      switch (action.type) {
        case "navigate":
          requireAllowedOrigin(action.url, session.allowedOrigins); dispatched = true;
          await session.page.goto(action.url, { waitUntil: "domcontentloaded", timeout });
          break;
        case "click": {
          const target = await uniqueLocator(session.page, action.target); dispatched = true;
          const opensNewPage = (await target.getAttribute("target")) === "_blank";
          const popup = opensNewPage ? session.context.waitForEvent("page", { timeout: 5_000 }).catch(() => undefined) : Promise.resolve(undefined);
          await target.click({ timeout });
          const candidate = await popup;
          if (candidate) {
            await candidate.waitForLoadState("domcontentloaded").catch(() => undefined);
            try { requireAllowedOrigin(candidate.url(), session.allowedOrigins); }
            catch (error) { await candidate.close().catch(() => undefined); throw error; }
            session.page = candidate;
          }
          break;
        }
        case "fillPublic":
          { const target = await uniqueLocator(session.page, action.target); dispatched = true; await target.fill(action.value, { timeout }); break; }
        case "fillCredential": {
          const value = await this.resolveCredential(session, action.credentialId);
          const target = await uniqueLocator(session.page, action.target);
          session.secrets.add(value); dispatched = true; await target.fill(value, { timeout }); break;
        }
        case "clickAndCaptureCredential": {
          const trigger = await uniqueLocator(session.page, action.target);
          dispatched = true;
          try {
            await trigger.click({ timeout });
            const captured = await waitForUniqueLocator(session.page, action.captureTarget, "visible", timeout);
            const value = await captured.inputValue({ timeout }).catch(async () => (await captured.textContent()) ?? "");
            if (!value) throw new Error("captured value was empty");
            session.secrets.add(value);
            const encrypted = encryptCredential(value);
            const credentialId = randomUUID();
            await this.database.transaction(async (client) => {
              await client.query(
                `INSERT INTO project_credentials(id,project_id,name,ciphertext,initialization_vector,authentication_tag)
                 VALUES($1,$2,$3,$4,$5,$6)`,
                [credentialId, session.projectId, action.credentialName, encrypted.ciphertext, encrypted.initializationVector, encrypted.authenticationTag],
              );
              const updated = await client.query(
                `UPDATE environments SET secret_refs=secret_refs || jsonb_build_array($3::text)
                 WHERE id=$1 AND project_id=$2 RETURNING id`,
                [session.environmentId, session.projectId, credentialId],
              );
              if (!updated.rowCount) throw new Error("environment disappeared during capture");
            });
            resultMetadata = { credentialId };
          } catch {
            throw new DirectError("DIRECT_CAPTURE_OUTCOME_UNKNOWN");
          }
          break;
        }
        case "select":
          { const target = await uniqueLocator(session.page, action.target); dispatched = true; await target.selectOption(action.value, { timeout }); break; }
        case "check":
          { const target = await uniqueLocator(session.page, action.target); dispatched = true; await target.setChecked(action.checked, { timeout }); break; }
        case "press":
          if (action.target) { const target = await uniqueLocator(session.page, action.target); dispatched = true; await target.press(action.key, { timeout }); }
          else { dispatched = true; await session.page.keyboard.press(action.key); } break;
        case "waitForElement":
          await waitForUniqueLocator(session.page, action.target, action.state, timeout); break;
        case "waitForUrl":
          await session.page.waitForURL((url) => urlMatches(url, action.value, action.match), { timeout }); break;
        case "inspectSection": {
          const section = await uniqueSection(session.page, action.heading);
          const content = (await section.innerText()).replace(/\s+/g, " ").trim().slice(0, action.maxCharacters);
          resultMetadata = { content: redactText(content, session.secrets) };
          break;
        }
        case "waitForText": {
          const target = await uniqueLocator(session.page, action.target);
          await target.filter({ hasText: action.match === "exact" ? new RegExp(`^\\s*${escapeRegExp(action.value)}\\s*$`) : action.value }).waitFor({ state: "visible", timeout });
          break;
        }
        case "inspectTarget": {
          const target = await uniqueLocator(session.page, action.target);
          const content = (await target.innerText()).replace(/\s+/g, " ").trim().slice(0, action.maxCharacters);
          resultMetadata = { content: redactText(content, session.secrets) };
          break;
        }
      }
      requireAllowedOrigin(session.page.url(), session.allowedOrigins);
      return { index, type: action.type, status: "succeeded", dispatchState: dispatched ? "dispatched" : "not_started", durationMs: performance.now() - startedAt, url: safeUrl(session.page.url()), ...resultMetadata };
    } catch (error) {
      return { index, type: action.type, status: "failed", dispatchState: dispatched ? "dispatched" : "not_started", durationMs: performance.now() - startedAt, reasonCode: directCode(error), url: safeUrl(session.page.url()) };
    }
  }

  private async observePage(session: DirectSession) {
    const startedAt = performance.now();
    requireAllowedOrigin(session.page.url(), session.allowedOrigins);
    const texts = await session.page.locator("h1,h2,h3,label").allTextContents();
    const controlTexts = await session.page.locator("button,a,[role=button],[role=link],[role=tab]").allTextContents();
    const dialogTexts = await session.page.locator("[role=dialog],dialog").allTextContents();
    const snapshot = texts
      .map((value) => value.replace(/\s+/g, " ").trim().slice(0, 120))
      .filter(Boolean)
      .slice(0, MAX_LANDMARKS);
    const inputLocator = session.page.locator("input,textarea,select");
    const inputs = [];
    for (let index = 0; index < Math.min(await inputLocator.count(), 12); index += 1) {
      const input = inputLocator.nth(index);
      inputs.push({
        type: (await input.getAttribute("type")) ?? "field",
        name: await input.getAttribute("name"),
        placeholder: await input.getAttribute("placeholder"),
        ariaLabel: await input.getAttribute("aria-label"),
      });
    }
    const redact = (value: string) => redactText(value, session.secrets);
    const compact = (values: string[], maximum: number) => values.map((value) => value.replace(/\s+/g, " ").trim().slice(0, 240)).filter(Boolean).slice(0, maximum).map(redact);
    return {
      url: safeUrl(session.page.url()),
      title: redact((await session.page.title()).slice(0, 200)),
      landmarks: snapshot.map((text) => ({ text: redact(text) })),
      controls: compact(controlTexts, 24),
      dialogs: compact(dialogTexts, 4),
      inputs: inputs.map((input) => Object.fromEntries(Object.entries(input).map(([key, value]) => [key, typeof value === "string" ? redact(value) : value]))),
      durationMs: performance.now() - startedAt,
    };
  }

  private requireSession(principal: Principal, id: string) {
    this.requireEnabled();
    const session = this.sessions.get(id);
    if (!session || session.owner !== ownerKey(principal)) throw new NotFoundException({ code: "DIRECT_SESSION_NOT_FOUND" });
    if (Date.now() - session.lastUsedAt > IDLE_TTL_MS) { void this.destroy(session); throw new NotFoundException({ code: "DIRECT_SESSION_EXPIRED" }); }
    return session;
  }

  private async loadEnvironment(principal: Principal, input: StartDirectSessionInput) {
    const workspaceId = principal.kind === "user" ? principal.workspaceId : null;
    const result = await this.database.query<{ baseOrigin: string; policy: { allowedOrigins: string[] } }>(
      `SELECT environment.base_origin AS "baseOrigin", environment.policy
       FROM environments environment JOIN projects project ON project.id=environment.project_id
       WHERE environment.id=$1 AND environment.project_id=$2
         AND ($3::uuid IS NULL OR project.workspace_id=$3)`,
      [input.environmentId, input.projectId, workspaceId],
    );
    if (!result.rowCount) throw new NotFoundException({ code: "DIRECT_ENVIRONMENT_NOT_FOUND" });
    return result.rows[0]!;
  }

  private async resolveCredential(session: DirectSession, credentialId: string) {
    const result = await this.database.query<{ ciphertext: string; initializationVector: string; authenticationTag: string }>(
      `SELECT credential.ciphertext, credential.initialization_vector AS "initializationVector", credential.authentication_tag AS "authenticationTag"
       FROM environments environment JOIN project_credentials credential ON credential.project_id=environment.project_id
       WHERE environment.id=$1 AND environment.project_id=$2 AND credential.id=$3
         AND credential.deleted_at IS NULL AND credential.security_status='active'
         AND environment.secret_refs ? ($3::uuid)::text`,
      [session.environmentId, session.projectId, credentialId],
    );
    if (!result.rowCount) throw new DirectError("DIRECT_CREDENTIAL_UNAVAILABLE");
    const row = result.rows[0]!;
    return decryptCredential({ ciphertext: Buffer.from(row.ciphertext, "base64"), initializationVector: Buffer.from(row.initializationVector, "base64"), authenticationTag: Buffer.from(row.authenticationTag, "base64") });
  }

  private async expireIdle() {
    await Promise.all([...this.sessions.values()].filter((session) => Date.now() - session.lastUsedAt > IDLE_TTL_MS && !session.busy).map((session) => this.destroy(session)));
  }

  private async destroy(session: DirectSession) {
    this.sessions.delete(session.id); session.secrets.clear();
    await session.context.close().catch(() => undefined); await session.browser.close().catch(() => undefined);
  }

  private requireEnabled() { if (process.env.SCRY_DIRECT_BROWSER_ENABLED !== "true") throw new NotFoundException({ code: "DIRECT_BROWSER_DISABLED" }); }
  private requireWrite(principal: Principal) { if (principal.kind === "user" && principal.role === "viewer") throw new ForbiddenException({ code: "DIRECT_BROWSER_WRITE_FORBIDDEN" }); }
}

class DirectError extends Error { constructor(readonly code: string) { super(code); } }
function ownerKey(principal: Principal) { return principal.kind === "user" ? `user:${principal.userId}` : "service:scry-service"; }
function requireAllowedOrigin(value: string, allowed: Set<string>) { let origin: string; try { origin = new URL(value).origin; } catch { throw new DirectError("DIRECT_URL_INVALID"); } if (!allowed.has(origin)) throw new DirectError("DIRECT_ORIGIN_NOT_ALLOWED"); }
function safeUrl(value: string) { try { const url = new URL(value); return `${url.origin}${url.pathname}`; } catch { return "about:blank"; } }
function directFailure(error: unknown) { return error instanceof DirectError ? new ConflictException({ code: error.code }) : error; }
function directCode(error: unknown) { if (error instanceof DirectError) return error.code; const message = error instanceof Error ? error.message : ""; if (/strict mode violation|matched \d+ elements/i.test(message)) return "DIRECT_TARGET_AMBIGUOUS"; if (/Timeout/i.test(message)) return "DIRECT_ACTION_TIMEOUT"; if (/closed|Target page/i.test(message)) return "DIRECT_BROWSER_CRASHED"; return "DIRECT_ACTION_FAILED"; }
function resolveLocator(page: Page, target: DirectLocator): Locator { const root: Page | Locator = "scope" in target && target.scope === "dialog" ? page.getByRole("dialog") : page; switch (target.strategy) { case "role": return root.getByRole(target.role, { ...(target.name ? { name: target.name } : {}), exact: target.exact }); case "label": return root.getByLabel(target.value, { exact: target.exact }); case "placeholder": return root.getByPlaceholder(target.value, { exact: target.exact }); case "text": return root.getByText(target.value, { exact: target.exact }); case "testId": return root.getByTestId(target.value); case "rowAction": return page.getByRole("row").filter({ hasText: target.rowText }).getByRole(target.role, { name: target.name, exact: target.exact }); case "credentialField": return page.locator(`[data-credential-field="${target.value}"]`); case "sectionRole": { const section = sectionLocator(page, target.sectionHeading); return section.getByRole(target.role, { ...(target.name ? { name: target.name } : {}), exact: target.exact }); } case "sectionLabel": return sectionLocator(page, target.sectionHeading).getByLabel(target.value, { exact: target.exact }); case "sectionLiveRegion": return sectionLocator(page, target.sectionHeading).locator("[aria-live]"); case "sectionResponse": return sectionLocator(page, target.sectionHeading).locator("pre.try-result:not([hidden])"); } }
async function uniqueLocator(page: Page, target: DirectLocator, allowZero = false) { const locator = resolveLocator(page, target); const count = await locator.count(); if (count > 1) throw new DirectError("DIRECT_TARGET_AMBIGUOUS"); if (count === 0 && !allowZero) throw new DirectError("DIRECT_TARGET_NOT_FOUND"); return locator; }
async function waitForUniqueLocator(page: Page, target: DirectLocator, state: "visible" | "hidden" | "attached" | "detached", timeout: number) { const locator = resolveLocator(page, target); await locator.first().waitFor({ state, timeout }); const count = await locator.count(); if (count > 1) throw new DirectError("DIRECT_TARGET_AMBIGUOUS"); return locator; }
function urlMatches(url: URL, expected: string, match: "exact" | "path" | "contains") { return match === "exact" ? url.href === expected : match === "path" ? url.pathname === expected : url.href.includes(expected); }
function sanitizeAction(action: DirectAction): Record<string, unknown> { if (action.type === "fillPublic") return { type: action.type, target: action.target, value: "[OMITTED]" }; return JSON.parse(JSON.stringify(action)); }
async function waitForDocumentSurface(page: Page, timeout: number) { await page.locator("h1,h2,h3,button,a,input,textarea,select,[role=button],[role=link],[role=tab]").first().waitFor({ state: "visible", timeout }).catch(() => undefined); }
function configuredExternalOrigins() { return new Set((process.env.SCRY_DIRECT_EXTERNAL_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean).map((value) => new URL(value).origin)); }
function sectionLocator(page: Page, heading: string) { return page.locator("section").filter({ has: page.getByRole("heading", { name: heading, exact: true }) }); }
async function uniqueSection(page: Page, heading: string) { const section = sectionLocator(page, heading); const count = await section.count(); if (count > 1) throw new DirectError("DIRECT_TARGET_AMBIGUOUS"); if (count === 0) throw new DirectError("DIRECT_TARGET_NOT_FOUND"); return section; }
function redactText(value: string, secrets: Set<string>) { let redacted = [...secrets].reduce((text, secret) => secret ? text.split(secret).join("[REDACTED]") : text, value); redacted = redacted.replace(/(["']?(?:client[_ -]?secret|access[_ -]?token|authorization|cookie|password|secret|token)["']?\s*[=:]\s*["']?)[^"'\s,}\]]+/gi, "$1[REDACTED]"); return redacted; }
function escapeRegExp(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
