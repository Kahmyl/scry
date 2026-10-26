import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import path from "node:path";
import type { BrowserContext, ElementHandle, Page, Request } from "playwright";
import type {
  BrowserCaptureReceipt,
  BrowserCommand,
  BrowserOutputSelection,
  ChronicleEvidencePort,
  ChronicleEvidenceSessionPort,
  PraxisCommandsPort,
  PraxisEffectsPort,
  VeilBrowserProtectionPort,
  VeilBrowserAuthorityPort,
  VeilBrowserCapturePort,
  PraxisOwnerIdentity,
  PraxisCommandOptions,
} from "@scry/contracts";
import { SanitizedBrowserRecorder } from "./recorder.js";
import { PraxisOwnerLease } from "./owner-lease.js";
import { OwnedBrowser } from "./owned-browser.js";
import { CommandLane, type CommandAttempt } from "./command-lane.js";

interface BrowserIncarnation {
  sessionId: string;
  state: "active" | "retired" | "command_cancelled";
  resources?: BrowserResources;
}

interface BrowserResources {
  sessionId: string;
  incarnation: BrowserIncarnation;
  lease: PraxisOwnerLease;
  state: "opening" | "active" | "retiring" | "retired" | "unconfirmed";
  expectedExit: boolean;
  launch?: Promise<OwnedBrowser>;
  recorder?: SanitizedBrowserRecorder;
  session?: ActiveSession;
  retirement?: Promise<void>;
  heartbeat?: NodeJS.Timeout;
}

interface ActiveSession {
  lease: PraxisOwnerLease;
  resources: BrowserResources;
  context: BrowserContext;
  page: Page;
  ownerGeneration: number;
  documentEpoch: number;
  runId: string;
  sessionId: string;
  baseOrigin: string;
  root: string;
  references: Map<string, { epoch: number; handle: ElementHandle<HTMLElement> }>;
  authority: VeilBrowserAuthorityPort;
  semanticHint: (value: string) => string;
  evidence: ChronicleEvidenceSessionPort;
  recorder: SanitizedBrowserRecorder;
  vault: VeilBrowserCapturePort;
  ownerLeaseToken: string;
}

const digest = (value: unknown) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");

function safeRedirectChain(
  status: number,
  location: string | undefined,
  requestUrl: string,
  baseOrigin: string,
): Array<{ status: number; sameOrigin: boolean; targetDigest: string }> {
  if (status < 300 || status > 399 || !location) return [];
  let target: URL;
  try {
    target = new URL(location, requestUrl);
  } catch {
    return [];
  }
  return [
    {
      status,
      sameOrigin: target.origin === new URL(baseOrigin).origin,
      targetDigest: digest(target.href),
    },
  ];
}

export class PraxisBrowserEngine {
  readonly #sessions = new Map<string, ActiveSession>();
  readonly #opening = new Map<string, Promise<{ sessionId: string; ownerGeneration: number }>>();
  readonly #closing = new Map<string, Promise<void>>();
  readonly #resources = new Map<string, BrowserResources>();
  readonly #incarnations = new Map<string, BrowserIncarnation>();
  readonly #commandLanes = new Map<string, CommandLane>();
  #stopping = false;
  constructor(
    private readonly commands: PraxisCommandsPort,
    private readonly effects: PraxisEffectsPort,
    private readonly evidenceService: ChronicleEvidencePort,
    private readonly protection: VeilBrowserProtectionPort,
    private readonly executionBudgetMs: (kind: BrowserCommand["kind"]) => number,
  ) {}

  async open(
    sessionId: string,
    commandIncarnation?: BrowserIncarnation,
  ): Promise<{ sessionId: string; ownerGeneration: number }> {
    if (this.#stopping) throw new Error("SCRY_BROWSER_SESSION_CLOSING");
    const priorRetirement = this.#resources.get(sessionId)?.retirement;
    let incarnation = commandIncarnation ?? this.incarnation(sessionId);
    if (this.#stopping) throw new Error("SCRY_BROWSER_SESSION_CLOSING");
    await this.effects.assertCompatibleBaseline();
    const resources = this.#resources.get(sessionId);
    if (resources?.retirement) await resources.retirement;
    if (this.#stopping) throw new Error("SCRY_BROWSER_SESSION_CLOSING");
    // A standalone open explicitly waiting on a known retiring owner may renew
    // after its confirmed exit. A cancelled/late startup must never do so.
    if (priorRetirement && !commandIncarnation && incarnation.state === "retired")
      incarnation = this.incarnation(sessionId);
    this.assertIncarnation(incarnation);
    const existing = this.#sessions.get(sessionId);
    if (this.#closing.has(sessionId)) throw new Error("SCRY_BROWSER_SESSION_CLOSING");
    if (existing) {
      await this.assertSessionOwner(existing);
      return { sessionId, ownerGeneration: existing.ownerGeneration };
    }
    const opening = this.#opening.get(sessionId);
    if (opening) return opening;
    const operation = this.#openNew(sessionId, incarnation);
    this.#opening.set(sessionId, operation);
    try {
      return await operation;
    } finally {
      this.#opening.delete(sessionId);
    }
  }

  async #openNew(
    sessionId: string,
    incarnation: BrowserIncarnation,
  ): Promise<{ sessionId: string; ownerGeneration: number }> {
    const scope = await this.commands.sessionContext(sessionId);
    this.assertIncarnation(incarnation);
    const ownerLeaseMs = 60_000;
    const owner = await this.effects.claimOwner(sessionId, `worker:${process.pid}`, ownerLeaseMs);
    const identity = { sessionId, generation: owner.generation, leaseToken: owner.leaseToken };
    const lease = new PraxisOwnerLease(identity, this.effects);
    const resources: BrowserResources = {
      sessionId,
      incarnation,
      lease,
      state: "opening",
      expectedExit: false,
    };
    incarnation.resources = resources;
    this.#resources.set(sessionId, resources);
    try {
      this.assertOpening(resources);
      resources.heartbeat = setInterval(
        () =>
          void lease.heartbeat(ownerLeaseMs).catch(() => {
            // Startup and active execution share the same revocation owner.
            void this.retire(resources).catch(() => undefined);
          }),
        20_000,
      );
      const root = path.resolve(
        process.env.SCRY_BROWSER_ARTIFACT_ROOT ?? "artifacts/browser",
        sessionId,
      );
      const [protectedValues, restoredPublicValues] = await Promise.all([
        this.commands.protectedValuesForSession(sessionId),
        this.commands.publicValuesForSession(sessionId),
      ]);
      const protectedSession = this.protection.createSession({
        scope,
        captureDirectory: path.join(root, "captures"),
        protectedValues,
        restoredPublicValues,
      });
      const { authority, vault } = protectedSession;
      const evidence = await this.evidenceService.openSession({
        root,
        runId: scope.runId,
        sessionId,
        protection: protectedSession.evidenceProtection,
        maxSessionBytes: 20 * 1024 * 1024,
        admission: lease,
      });
      const durableCaptures = await this.effects.durableCapturesForSession(sessionId);
      await lease.run(() => protectedSession.restoreCaptures(durableCaptures));
      const checkpoint = await this.commands.loadBrowserCheckpoint(sessionId, owner.generation);
      this.assertOpening(resources);
      await lease.run(async () => undefined);
      this.assertOpening(resources);
      resources.launch = OwnedBrowser.launch({
        headless: process.env.SCRY_BROWSER_HEADLESS !== "false",
        channel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
      });
      const custody = await resources.launch;
      custody.browser.once("disconnected", () => {
        if (!resources.expectedExit) void this.retire(resources).catch(() => undefined);
      });
      this.assertOpening(resources);
      const context = await custody.browser.newContext({
        ...(checkpoint ? { storageState: checkpoint.storageState } : {}),
      });
      this.assertOpening(resources);
      if (checkpoint && Object.keys(checkpoint.sessionStorage).length > 0) {
        await context.addInitScript(
          ({ origin, values }) => {
            if (window.location.origin !== origin) return;
            for (const [key, value] of Object.entries(values))
              window.sessionStorage.setItem(key, value);
          },
          { origin: new URL(scope.baseOrigin).origin, values: checkpoint.sessionStorage },
        );
      }
      this.assertOpening(resources);
      const page = await context.newPage();
      this.assertOpening(resources);
      const recorder = new SanitizedBrowserRecorder({
        recording: evidence.createRecording(protectedSession.recordingProtection),
        privacyOptions: protectedSession.privacyOptions,
      });
      resources.recorder = recorder;
      await recorder.start(context);
      this.assertOpening(resources);
      const session: ActiveSession = {
        lease,
        resources,
        context,
        page,
        ownerGeneration: owner.generation,
        documentEpoch: 0,
        runId: scope.runId,
        sessionId,
        baseOrigin: scope.baseOrigin,
        root,
        references: new Map(),
        authority,
        semanticHint: protectedSession.semanticHint,
        evidence,
        recorder,
        vault,
        ownerLeaseToken: owner.leaseToken,
      };
      resources.session = session;
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) {
          session.documentEpoch += 1;
          session.references.clear();
        }
      });
      if (checkpoint) {
        await lease.run(async () => undefined);
        this.assertOpening(resources);
        this.assertOrigin(session, checkpoint.resumeUrl);
        await page.goto(checkpoint.resumeUrl);
      }
      await lease.run(async () => undefined);
      this.assertOpening(resources);
      resources.state = "active";
      this.#sessions.set(sessionId, session);
      return { sessionId, ownerGeneration: owner.generation };
    } catch (error) {
      await this.retire(resources);
      await this.effects
        .releaseOwner(sessionId, owner.generation, owner.leaseToken)
        .catch(() => undefined);
      throw error;
    }
  }

  async execute(
    sessionId: string,
    command: BrowserCommand,
    options?: PraxisCommandOptions,
  ): Promise<Record<string, unknown>> {
    const lane = this.#commandLanes.get(sessionId) ?? new CommandLane();
    this.#commandLanes.set(sessionId, lane);
    let executedIncarnation: BrowserIncarnation | undefined;
    try {
      return await lane.run(
        options ?? { remainingMs: this.executionBudgetMs(command.kind) },
        async (attempt) => {
          const incarnation = this.incarnation(sessionId);
          executedIncarnation = incarnation;
          const revoke = () => {
            incarnation.state = "command_cancelled";
            incarnation.resources?.lease.revoke();
          };
          attempt.signal.addEventListener("abort", revoke, { once: true });
          attempt.bind({
            stop: async () => {
              revoke();
              if (incarnation.resources) await this.retire(incarnation.resources);
            },
          });
          try {
            const current = async () => {
              attempt.assertActive();
              await options?.assertCurrent?.();
              attempt.assertActive();
            };
            const session = await this.requiredSession(sessionId, incarnation);
            try {
              const result = await this.executeInSession(session, command, attempt, current);
              attempt.assertActive();
              if (command.kind !== "close" && command.kind !== "close_for_failure") {
                await this.persistCheckpoint(session, attempt);
                await this.assertSessionOwner(session);
              }
              attempt.assertActive();
              return result;
            } catch (error) {
              if (error instanceof Error && error.name === "TimeoutError") {
                // Driver timeout is not proof that an in-flight action stopped.
                await this.evict(session);
                throw new Error("SCRY_BROWSER_ACTION_TIMEOUT");
              }
              if (
                error instanceof Error &&
                [
                  "SCRY_BROWSER_PROVIDER_RESPONSE_TIMEOUT",
                  "SCRY_BROWSER_RESPONSE_BODY_TIMEOUT",
                  "SCRY_BROWSER_MUTATION_REQUEST_TIMEOUT",
                  "SCRY_BROWSER_READ_ONLY_SETTLE_TIMEOUT",
                ].includes(error.message)
              )
                await this.evict(session);
              if (
                error instanceof Error &&
                [
                  "SCRY_BROWSER_OWNER_FENCED",
                  "SCRY_BROWSER_COMMAND_CLAIM_FENCED",
                  "SCRY_BROWSER_COMMAND_CLAIM_UNAVAILABLE",
                  "SCRY_BROWSER_COMMAND_DEADLINE_EXCEEDED",
                ].includes(error.message)
              )
                await this.evict(session);
              throw error;
            }
          } finally {
            attempt.signal.removeEventListener("abort", revoke);
          }
        },
      );
    } finally {
      if (
        lane.available &&
        !this.#resources.has(sessionId) &&
        this.#commandLanes.get(sessionId) === lane
      )
        this.#commandLanes.delete(sessionId);
      const incarnation = executedIncarnation;
      if (
        incarnation &&
        incarnation.state !== "active" &&
        !incarnation.resources &&
        this.#incarnations.get(sessionId) === incarnation
      )
        this.#incarnations.delete(sessionId);
    }
  }

  private async executeInSession(
    session: ActiveSession,
    command: BrowserCommand,
    attempt: CommandAttempt,
    current: () => Promise<void>,
  ): Promise<Record<string, unknown>> {
    await current();
    switch (command.kind) {
      case "navigate": {
        this.assertOrigin(session, command.url);
        await session.page.goto(command.url, { timeout: attempt.remainingMs() });
        return this.observe(session);
      }
      case "observe":
        return this.observe(session);
      case "fill": {
        const handle = this.handle(session, command.reference);
        if (command.protectedValueId) {
          let value = await this.commands.protectedValueForBrowser(
            session.sessionId,
            command.protectedValueId,
          );
          try {
            await current();
            await handle.fill(value, { timeout: attempt.remainingMs() });
          } finally {
            value = "";
          }
        } else await handle.fill(command.publicValue ?? "", { timeout: attempt.remainingMs() });
        return { documentEpoch: session.documentEpoch, filled: true };
      }
      case "click":
        await this.readOnlyInteraction(
          session,
          () => this.handle(session, command.reference).click({ timeout: attempt.remainingMs() }),
          attempt,
          current,
        );
        return this.observe(session);
      case "press":
        await this.readOnlyInteraction(
          session,
          () =>
            this.handle(session, command.reference).press(command.key, {
              timeout: attempt.remainingMs(),
            }),
          attempt,
          current,
        );
        return this.observe(session);
      case "capture_dom":
        return this.captureDom(session, command.effectId, command.reference);
      case "commit":
        return this.commit(session, command, attempt, current);
      case "publish_capture":
        return this.publish(session, command.effectId, command.captureId, command.selections);
      case "discard_capture":
        return this.discard(session, command.effectId, command.captureId);
      case "determine":
        return (await this.effects.determine(
          command.effectId,
          session.ownerGeneration,
          command.outcome,
          command.source,
        )) as unknown as Record<string, unknown>;
      case "close":
        await this.close(session.sessionId);
        return { closed: true };
      case "close_for_failure":
        await this.closeForFailure(session.sessionId);
        return { closed: true, unresolvedEffectsPreserved: true };
    }
  }

  async close(sessionId: string): Promise<void> {
    return this.closeSession(sessionId, false);
  }

  async closeForFailure(sessionId: string): Promise<void> {
    return this.closeSession(sessionId, true);
  }

  private async closeSession(sessionId: string, forFailure: boolean): Promise<void> {
    const existing = this.#closing.get(sessionId);
    if (existing) return existing;
    const operation = this.finishSession(sessionId, forFailure);
    this.#closing.set(sessionId, operation);
    try {
      await operation;
    } finally {
      this.#closing.delete(sessionId);
    }
  }

  private async finishSession(sessionId: string, forFailure: boolean): Promise<void> {
    const session = this.#sessions.get(sessionId);
    if (!session) return;
    await this.assertSessionOwner(session);
    if (forFailure)
      await this.effects.prepareFailureFinalization(sessionId, session.ownerGeneration);
    else await this.effects.assertNoPendingEffectOutcomes(sessionId);
    const unsettled = await this.effects.unsettledCaptureIds(sessionId);
    if (unsettled.length > 0)
      throw new Error(`SCRY_BROWSER_CAPTURES_UNSETTLED:${unsettled.join(",")}`);
    try {
      await session.evidence.prepareClosure();
      await session.recorder.close();
      session.resources.expectedExit = true;
      await (await session.resources.launch!).close();
      session.lease.assertActive();
      const completion = await session.evidence.seal({
        renderVideo: process.env.SCRY_BROWSER_RENDER_VIDEO === "true",
        actionLedger: () => this.commands.safeActionLedger(sessionId),
        ...(process.env.SCRY_BROWSER_CHROME_PATH
          ? { executablePath: process.env.SCRY_BROWSER_CHROME_PATH }
          : {}),
      });
      session.lease.assertActive();
      await this.effects.completeEvidence(this.ownerIdentity(session), completion);
      await this.commands.deleteBrowserCheckpoint(sessionId, session.ownerGeneration);
    } finally {
      await this.evict(session);
    }
  }

  async closeAll(): Promise<void> {
    this.#stopping = true;
    // Host shutdown is interruption, not an implicit business/evidence close.
    // Fence first, then stop every acquired/launching process independently.
    // Startup waiting on a database call cannot launch after this flag is set.
    const outcomes = await Promise.allSettled(
      [...this.#resources.values()].map((resource) => this.retire(resource)),
    );
    if (outcomes.some((outcome) => outcome.status === "rejected"))
      throw new Error("SCRY_BROWSER_PROCESS_TERMINATION_UNCONFIRMED");
  }

  private ownerIdentity(session: ActiveSession): PraxisOwnerIdentity {
    return {
      sessionId: session.sessionId,
      generation: session.ownerGeneration,
      leaseToken: session.ownerLeaseToken,
    };
  }

  private async assertSessionOwner(session: ActiveSession): Promise<void> {
    try {
      await session.lease.run(async () => undefined);
    } catch (error) {
      await this.evict(session);
      throw error;
    }
  }

  private async evict(session: ActiveSession): Promise<void> {
    return this.retire(session.resources);
  }

  private assertOpening(resources: BrowserResources): void {
    if (this.#stopping) throw new Error("SCRY_BROWSER_SESSION_CLOSING");
    this.assertIncarnation(resources.incarnation);
    if (resources.state !== "opening") throw new Error("SCRY_BROWSER_OWNER_FENCED");
    resources.lease.assertActive();
  }

  private retire(resources: BrowserResources): Promise<void> {
    if (resources.retirement) return resources.retirement;
    resources.state = "retiring";
    if (resources.incarnation.state === "active") resources.incarnation.state = "retired";
    resources.lease.revoke();
    if (resources.heartbeat) clearInterval(resources.heartbeat);
    if (resources.session) {
      resources.session.references.clear();
    }
    resources.retirement = Promise.resolve()
      .then(async () => {
        // Detach admission immediately, but never wait for a stalled protocol
        // detach before physically terminating the process that owns it.
        const recording = Promise.resolve()
          .then(() => resources.recorder?.abort())
          .then(
            () => true,
            () => false,
          );
        const custody = await resources.launch?.catch((error: unknown) => {
          // A rejected acquisition may still own an unconfirmed child. Never
          // turn its explicit cleanup failure into proof that nothing launched.
          if (
            error instanceof Error &&
            error.message === "SCRY_BROWSER_PROCESS_TERMINATION_UNCONFIRMED"
          )
            throw error;
          return undefined;
        });
        await custody?.terminate();
        if (!(await bounded(recording, 2000, "SCRY_BROWSER_RECORDER_STOP_TIMEOUT")))
          throw new Error("SCRY_BROWSER_RECORDER_STOP_TIMEOUT");
        resources.state = "retired";
        if (this.#resources.get(resources.sessionId) === resources)
          this.#resources.delete(resources.sessionId);
        if (this.#sessions.get(resources.sessionId) === resources.session)
          this.#sessions.delete(resources.sessionId);
        if (this.#incarnations.get(resources.sessionId) === resources.incarnation)
          this.#incarnations.delete(resources.sessionId);
      })
      .catch((error) => {
        resources.state = "unconfirmed";
        // Retain the exact retirement promise. No later local open may mistake
        // an unconfirmed process/recorder drain for a vacant session.
        throw error;
      });
    return resources.retirement;
  }

  private incarnation(sessionId: string): BrowserIncarnation {
    let incarnation = this.#incarnations.get(sessionId);
    if (!incarnation) {
      incarnation = { sessionId, state: "active" };
      this.#incarnations.set(sessionId, incarnation);
    }
    return incarnation;
  }
  private assertIncarnation(incarnation: BrowserIncarnation): void {
    if (
      incarnation.state !== "active" ||
      this.#incarnations.get(incarnation.sessionId) !== incarnation
    )
      throw new Error("SCRY_BROWSER_OWNER_FENCED");
  }
  private async requiredSession(
    sessionId: string,
    incarnation: BrowserIncarnation,
  ): Promise<ActiveSession> {
    await this.open(sessionId, incarnation);
    this.assertIncarnation(incarnation);
    return this.#sessions.get(sessionId)!;
  }

  private async observe(session: ActiveSession): Promise<Record<string, unknown>> {
    session.references.clear();
    const controls: Array<Record<string, unknown>> = [];
    const locator = session.page.locator(
      "a,button,input,textarea,select,[role=button],[role=link]",
    );
    const count = Math.min(await locator.count(), 200);
    for (let index = 0; index < count; index += 1) {
      const handle = (await locator
        .nth(index)
        .elementHandle()) as ElementHandle<HTMLElement> | null;
      if (!handle) continue;
      const facts = await handle.evaluate((element) => ({
        tag: element.tagName.toLowerCase(),
        type: element.getAttribute("type"),
        role: element.getAttribute("role"),
        name:
          element.getAttribute("aria-label") ??
          element.getAttribute("placeholder") ??
          element.textContent?.trim().slice(0, 200) ??
          "",
      }));
      const reference = randomUUID();
      session.references.set(reference, { epoch: session.documentEpoch, handle });
      controls.push({
        reference,
        tag: facts.tag,
        type: facts.type,
        role: facts.role,
        name: session.authority.sanitize(facts.name, "agent_observation"),
      });
    }
    const regions: Array<Record<string, unknown>> = [];
    const regionLocator = session.page.locator(
      "dialog,[role=dialog],[aria-live=polite],[aria-live=assertive],main,section,article",
    );
    const regionCount = Math.min(await regionLocator.count(), 100);
    for (let index = 0; index < regionCount; index += 1) {
      const handle = (await regionLocator
        .nth(index)
        .elementHandle()) as ElementHandle<HTMLElement> | null;
      if (!handle) continue;
      const facts = await handle.evaluate((element) => ({
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute("role"),
        name: element.getAttribute("aria-label") ?? element.getAttribute("aria-labelledby") ?? "",
        text: element.textContent?.trim().slice(0, 500) ?? "",
      }));
      const reference = randomUUID();
      session.references.set(reference, { epoch: session.documentEpoch, handle });
      regions.push({
        reference,
        tag: facts.tag,
        role: facts.role,
        name: session.authority.sanitize(facts.name, "agent_observation"),
        text: session.authority.sanitize(facts.text, "agent_observation"),
      });
    }
    const bodyText = session.authority.sanitize(
      (
        await session.page
          .locator("body")
          .innerText()
          .catch(() => "")
      ).slice(0, 20_000),
      "agent_observation",
    );
    return {
      url: session.authority.sanitize(session.page.url(), "agent_observation"),
      title: session.authority.sanitize(await session.page.title(), "agent_observation"),
      documentEpoch: session.documentEpoch,
      controls,
      regions,
      text: bodyText,
      truncated: bodyText.length >= 20_000,
    };
  }

  private handle(session: ActiveSession, reference: string): ElementHandle<HTMLElement> {
    const target = session.references.get(reference);
    if (!target || target.epoch !== session.documentEpoch)
      throw new Error("SCRY_BROWSER_REFERENCE_STALE");
    return target.handle;
  }

  private assertOrigin(session: ActiveSession, url: string): void {
    if (new URL(url).origin !== new URL(session.baseOrigin).origin)
      throw new Error("SCRY_BROWSER_ORIGIN_NOT_ALLOWED");
  }

  private async persistCheckpoint(session: ActiveSession, attempt: CommandAttempt): Promise<void> {
    attempt.assertActive();
    const resumeUrl = session.page.url();
    if (resumeUrl === "about:blank") return;
    this.assertOrigin(session, resumeUrl);
    const storageState = await session.context.storageState({ indexedDB: true });
    attempt.assertActive();
    const sessionStorage = await session.page.evaluate(() =>
      Object.fromEntries(
        Array.from({ length: window.sessionStorage.length }, (_, index) => {
          const key = window.sessionStorage.key(index) ?? "";
          return [key, window.sessionStorage.getItem(key) ?? ""] as const;
        }).filter(([key]) => key.length > 0),
      ),
    );
    attempt.assertActive();
    await this.commands.saveBrowserCheckpoint(session.sessionId, session.ownerGeneration, {
      resumeUrl,
      storageState,
      sessionStorage,
    });
  }

  private async commit(
    session: ActiveSession,
    command: Extract<BrowserCommand, { kind: "commit" }>,
    attempt: CommandAttempt,
    current: () => Promise<void>,
  ): Promise<Record<string, unknown>> {
    const existing = await this.effects.recoverAdmittedEffect({
      sessionId: session.sessionId,
      idempotencyKey: command.effectIdempotencyKey,
      effectClass: command.effectClass,
      expectedOrigin: new URL(session.baseOrigin).origin,
      intentSummary: command.intentSummary,
    });
    if (existing)
      return {
        effectId: existing.effectId,
        replay: true,
        ...(await this.effects.recoverEffect(existing.effectId)),
      };
    const target = this.handle(session, command.reference);
    const targetFacts = await target.evaluate((element) => ({
      tag: element.tagName.toLowerCase(),
      type: element.getAttribute("type") ?? "",
      role: element.getAttribute("role") ?? "",
      name: element.getAttribute("aria-label") ?? element.textContent?.trim().slice(0, 200) ?? "",
    }));
    const targetDigest = digest({
      ...targetFacts,
      name: session.authority.sanitize(targetFacts.name, "database_safe_field"),
    });
    const actionDigest = digest({
      kind: command.kind,
      effectClass: command.effectClass,
      intentSummary: command.intentSummary,
      path: new URL(session.page.url()).pathname,
      targetDigest,
    });
    const effect = await this.effects.admitEffect({
      sessionId: session.sessionId,
      ownerGeneration: session.ownerGeneration,
      documentEpoch: session.documentEpoch,
      idempotencyKey: command.effectIdempotencyKey,
      effectClass: command.effectClass,
      expectedOrigin: new URL(session.baseOrigin).origin,
      targetDigest,
      actionDigest,
      intentSummary: command.intentSummary,
    });
    if (!effect.replay && effect.effect.dispatch_state === "not_started") {
      const protectionBarrier = session.authority.begin(effect.effect.id);
      let writeCount = 0;
      let blockedWrite = false;
      let dispatchBegan = false;
      let captureDurable = false;
      type OwnedResult = { receipt: BrowserCaptureReceipt } | { error: Error };
      let settleOwned!: (result: OwnedResult) => void;
      const ownedResult = new Promise<OwnedResult>((resolve) => {
        settleOwned = resolve;
      });
      const gate = async (route: import("playwright").Route) => {
        try {
          attempt.assertActive();
        } catch {
          return route.abort("blockedbyclient");
        }
        const request = route.request();
        const method = request.method();
        const sameOrigin = new URL(request.url()).origin === new URL(session.baseOrigin).origin;
        if (!sameOrigin) {
          if (!["GET", "HEAD", "OPTIONS"].includes(method)) blockedWrite = true;
          return route.abort("blockedbyclient");
        }
        if (["GET", "HEAD", "OPTIONS"].includes(method)) return route.continue();
        if (sameOrigin && writeCount === 0) {
          writeCount += 1;
          try {
            await current();
            await this.effects.markDispatchStarted(effect.effect.id, session.ownerGeneration);
            await current();
            dispatchBegan = true;
            const fetched = await bounded(
              route.fetch({ timeout: attempt.remainingMs(command.timeoutMs), maxRedirects: 0 }),
              attempt.remainingMs(command.timeoutMs),
              "SCRY_BROWSER_PROVIDER_RESPONSE_TIMEOUT",
            );
            const body = Buffer.from(
              await bounded(
                fetched.body(),
                attempt.remainingMs(command.timeoutMs),
                "SCRY_BROWSER_RESPONSE_BODY_TIMEOUT",
              ),
            );
            attempt.assertActive();
            const headers = fetched.headers();
            const redirectChain = safeRedirectChain(
              fetched.status(),
              headers.location,
              request.url(),
              session.baseOrigin,
            );
            const receipt = await session.vault.captureHttpResponse({
              effectId: effect.effect.id,
              method,
              url: request.url(),
              status: fetched.status(),
              contentType: headers["content-type"] ?? "application/octet-stream",
              body,
              redirectChain,
              protectionBarrier,
            });
            const durable = await session.vault.exportDurableCapture(receipt.captureId);
            await this.effects.registerCapture({
              effectId: effect.effect.id,
              ownerGeneration: session.ownerGeneration,
              captureId: receipt.captureId,
              evidenceFormat: 1,
              objectKey: `postgres://browser_captures/${receipt.captureId}`,
              ciphertextDigest: durable.encryptedPayloadDigest,
              authenticatedMetadata: {
                receiptDigest: digest(receipt),
                protectionScopeDigest: protectionBarrier.scopeDigest,
                protectionDecisionRevision: protectionBarrier.decisionRevision,
                storedReceipt: durable.storedReceipt,
              },
              contentClass: receipt.contentClass,
              byteSize: receipt.bodyBytes,
              structuralIndex: receipt.structuralIndex,
              capturedAt: new Date(receipt.capturedAt),
              expiresAt: new Date(receipt.expiresAt),
              encryptedPayload: durable.encryptedPayload,
              encryptedPayloadDigest: durable.encryptedPayloadDigest,
              responseStatus: fetched.status(),
            });
            captureDurable = true;
            await current();
            await route.fulfill({ response: fetched, body });
            settleOwned({ receipt });
          } catch (error) {
            settleOwned({ error: error instanceof Error ? error : new Error(String(error)) });
            await route.abort("failed").catch(() => undefined);
          }
          return;
        }
        blockedWrite = true;
        return route.abort("blockedbyclient");
      };
      try {
        await session.page.route("**/*", gate);
        await current();
        await target.click({ noWaitAfter: true, timeout: attempt.remainingMs(command.timeoutMs) });
        const owned = await bounded(
          ownedResult,
          attempt.remainingMs(command.timeoutMs),
          "SCRY_BROWSER_MUTATION_REQUEST_TIMEOUT",
        );
        if ("error" in owned) throw owned.error;
        const { receipt } = owned;
        await session.page
          .waitForLoadState("domcontentloaded", {
            timeout: attempt.remainingMs(Math.min(command.timeoutMs, 5_000)),
          })
          .catch(() => undefined);
        await session.page.waitForTimeout(100);
        const successorObservation = await this.observe(session);
        return {
          effectId: effect.effect.id,
          capture: receipt,
          replay: false,
          writeRequests: writeCount,
          blockedAdditionalWrite: blockedWrite,
          successorObservation,
        };
      } catch (error) {
        if (!captureDurable) session.authority.abort(protectionBarrier);
        if (dispatchBegan && !captureDurable)
          await this.effects
            .markUnknown(effect.effect.id, session.ownerGeneration, "dispatch_result_unresolved")
            .catch(() => undefined);
        else if (!dispatchBegan)
          await this.effects
            .determine(
              effect.effect.id,
              session.ownerGeneration,
              "not_applied",
              "pre_dispatch_failure",
            )
            .catch(() => undefined);
        throw error;
      } finally {
        await session.page.unrouteAll({ behavior: "ignoreErrors" });
      }
    }
    return {
      effectId: effect.effect.id,
      replay: true,
      ...(await this.effects.recoverEffect(effect.effect.id)),
    };
  }

  private async readOnlyInteraction(
    session: ActiveSession,
    action: () => Promise<void>,
    attempt: CommandAttempt,
    current: () => Promise<void>,
  ): Promise<void> {
    let blocked = false;
    let actionStarted = false;
    let lastNetworkActivity = performance.now();
    const pendingReads = new Set<Request>();
    const isRead = (request: Request) => ["GET", "HEAD", "OPTIONS"].includes(request.method());
    const onRequest = (request: Request) => {
      if (!actionStarted || !isRead(request)) return;
      pendingReads.add(request);
      lastNetworkActivity = performance.now();
    };
    const onRequestSettled = (request: Request) => {
      if (!pendingReads.delete(request)) return;
      lastNetworkActivity = performance.now();
    };
    const gate = async (route: import("playwright").Route) => {
      try {
        attempt.assertActive();
      } catch {
        return route.abort("blockedbyclient");
      }
      if (["GET", "HEAD", "OPTIONS"].includes(route.request().method())) return route.continue();
      blocked = true;
      return route.abort("blockedbyclient");
    };
    session.page.on("request", onRequest);
    session.page.on("requestfinished", onRequestSettled);
    session.page.on("requestfailed", onRequestSettled);
    await session.page.route("**/*", gate);
    try {
      await current();
      actionStarted = true;
      lastNetworkActivity = performance.now();
      await action();
      const deadline = performance.now() + Math.min(10000, attempt.remainingMs());
      while (pendingReads.size > 0 || performance.now() - lastNetworkActivity < 100) {
        attempt.assertActive();
        if (performance.now() >= deadline) throw new Error("SCRY_BROWSER_READ_ONLY_SETTLE_TIMEOUT");
        await session.page.waitForTimeout(25);
      }
    } finally {
      session.page.off("request", onRequest);
      session.page.off("requestfinished", onRequestSettled);
      session.page.off("requestfailed", onRequestSettled);
      await session.page.unrouteAll({ behavior: "ignoreErrors" });
    }
    if (blocked) throw new Error("SCRY_BROWSER_MUTATION_REQUIRES_COMMIT");
  }

  private async captureDom(
    session: ActiveSession,
    effectId: string,
    reference: string,
  ): Promise<Record<string, unknown>> {
    const protectionBarrier = session.authority.begin(effectId);
    let captured = false;
    try {
      const effect = await this.effects.observeEffect(effectId);
      if (effect.session_id !== session.sessionId || effect.dispatch_state !== "acknowledged")
        throw new Error("SCRY_BROWSER_DOM_CAPTURE_EFFECT_INVALID");
      await this.effects.assertCaptureSlotAvailable(effectId, session.sessionId);
      const handle = this.handle(session, reference);
      const structured = await handle.evaluate((root) => {
        const result: Record<string, unknown> = {};
        const stack: Array<{ element: Element; depth: number; target: Record<string, unknown> }> = [
          { element: root, depth: 0, target: result },
        ];
        let nodes = 0;
        while (stack.length > 0) {
          const current = stack.pop()!;
          nodes += 1;
          if (nodes > 500 || current.depth > 12) {
            current.target.truncated = true;
            continue;
          }
          const html = current.element as HTMLElement;
          const form = current.element as HTMLInputElement;
          let ownText = "";
          for (const node of current.element.childNodes) {
            if (node.nodeType === Node.TEXT_NODE) ownText += `${node.textContent ?? ""} `;
          }
          current.target.tag = current.element.tagName.toLowerCase();
          current.target.role = current.element.getAttribute("role") ?? "";
          current.target.label = current.element.getAttribute("aria-label") ?? "";
          ownText = ownText.trim().slice(0, 4_000);
          if (ownText) current.target.text = ownText;
          if (["INPUT", "TEXTAREA", "SELECT"].includes(current.element.tagName))
            current.target.value = form.value;
          current.target.visible = Boolean(
            html.offsetWidth || html.offsetHeight || html.getClientRects().length,
          );
          const elements = [...current.element.children].slice(0, 100);
          if (elements.length > 0) {
            const children: Array<Record<string, unknown>> = [];
            for (let index = 0; index < elements.length; index += 1) children.push({});
            current.target.children = children;
            for (let index = elements.length - 1; index >= 0; index -= 1) {
              stack.push({
                element: elements[index]!,
                depth: current.depth + 1,
                target: children[index]!,
              });
            }
          }
        }
        return result;
      });
      sanitizeDomSemanticHints(structured, session.semanticHint);
      const body = Buffer.from(JSON.stringify(structured));
      const receipt = await session.vault.captureHttpResponse({
        effectId,
        method: "DOM",
        url: session.page.url(),
        status: 200,
        contentType: "application/vnd.scry.dom+json",
        body,
        protectionBarrier,
      });
      captured = true;
      const durable = await session.vault.exportDurableCapture(receipt.captureId);
      await this.effects.registerCapture({
        effectId,
        ownerGeneration: session.ownerGeneration,
        captureId: receipt.captureId,
        evidenceFormat: 1,
        objectKey: `postgres://browser_captures/${receipt.captureId}`,
        ciphertextDigest: durable.encryptedPayloadDigest,
        authenticatedMetadata: {
          receiptDigest: digest(receipt),
          documentEpoch: session.documentEpoch,
          storedReceipt: durable.storedReceipt,
        },
        contentClass: receipt.contentClass,
        byteSize: receipt.bodyBytes,
        structuralIndex: receipt.structuralIndex,
        capturedAt: new Date(receipt.capturedAt),
        expiresAt: new Date(receipt.expiresAt),
        encryptedPayload: durable.encryptedPayload,
        encryptedPayloadDigest: durable.encryptedPayloadDigest,
      });
      return { effectId, capture: receipt };
    } catch (error) {
      if (!captured) session.authority.abort(protectionBarrier);
      throw error;
    }
  }

  private async publish(
    session: ActiveSession,
    effectId: string,
    captureId: string,
    selections: BrowserOutputSelection[],
  ): Promise<Record<string, unknown>> {
    const outputs = await session.vault.publish(captureId, selections, {
      deferReleaseUntilDurablePublication: true,
    });
    const protectedPlaintext: Record<string, string> = {};
    try {
      for (const [name, reference] of Object.entries(outputs.protectedOutputs))
        await session.vault.deliverProtectedToBrowser(reference.reference, {
          fill: async (value) => {
            protectedPlaintext[name] = value;
          },
        });
      const persisted = await this.effects.publishOutputs({
        effectId,
        ownerGeneration: session.ownerGeneration,
        captureId,
        selectionDigest: digest(selections),
        publicOutputs: outputs.publicOutputs,
        protectedOutputs: protectedPlaintext,
        decisions: outputs.decisions,
      });
      await session.vault.releasePublishedBarrier(captureId);
      await session.recorder.checkpoint();
      return {
        effectId,
        captureId,
        publicOutputs: outputs.publicOutputs,
        protectedReferences: persisted.protectedReferences,
      };
    } finally {
      for (const key of Object.keys(protectedPlaintext)) protectedPlaintext[key] = "";
    }
  }

  private async discard(
    session: ActiveSession,
    effectId: string,
    captureId: string,
  ): Promise<Record<string, unknown>> {
    await this.effects.discardCapture({
      effectId,
      ownerGeneration: session.ownerGeneration,
      captureId,
    });
    const discarded = await session.vault.discard(captureId);
    return { effectId, captureId, phase: discarded.receipt.phase };
  }
}

function sanitizeDomSemanticHints(
  root: Record<string, unknown>,
  semanticHint: (value: string) => string,
): void {
  const stack: Record<string, unknown>[] = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const label = current.label;
    delete current.label;
    if (typeof label === "string") current.semanticHint = semanticHint(label);
    const children = current.children;
    if (Array.isArray(children)) {
      for (const child of children)
        if (child && typeof child === "object" && !Array.isArray(child))
          stack.push(child as Record<string, unknown>);
    }
  }
}

async function bounded<T>(operation: Promise<T>, timeoutMs: number, code: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(code)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
