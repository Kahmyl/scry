import { describe, expect, it, vi } from "vitest";
import { SecretRedactor } from "@scry/policy";
import { registerPraxisVeilAuthority } from "@scry/praxis";
import {
  compileVeilPolicy,
  VeilAuthority,
  VeilRuntimeCoordinator,
  type PrivacyCollector,
} from "@scry/veil";

import { executeAction } from "../src/action-runtime.js";
import { executeInteractionCompatibility } from "../src/execution-kernel.js";
import { openTestBrowser } from "./kernel-harness.js";

const target = {
  concept: "sign in",
  requiredCapabilities: ["pointer_activatable" as const],
  preferredEvidence: {
    roles: ["button" as const], names: ["Sign in"], labels: [], descriptions: [],
    placeholders: [], inputTypes: [],
  },
  scope: { kind: "page" as const }, relations: [], prohibited: ["hidden" as const, "disabled" as const],
  risk: "authentication" as const, confidence: { requiredFamilies: [] },
};

describe("native-first action runtime", () => {
  it("keeps protected fill resolution in Praxis without entering privacy on pre-dispatch failure", async () => {
    const opened = await openTestBrowser();
    const unregister = registerPraxisVeilAuthority(opened.page, {
      authority: new VeilAuthority(compileVeilPolicy({ profile: "balanced", allowedOrigins: ["https://example.test"] })),
      userId: "test", environmentId: "test", browserContextId: "test-context",
    });
    const lifecycle: string[] = [];
    const privacyGate = {
      prepare: vi.fn(async () => { lifecycle.push("prepare"); }),
      beginProtected: vi.fn(async () => { lifecycle.push("protected"); }),
      seal: vi.fn(async () => { lifecycle.push("sealed"); }),
    };
    const onMutationDispatch = vi.fn();
    const native = vi.fn();
    try {
      await opened.page.setContent('<section aria-label="Other"><label>Client ID<input></label></section>');
      const outcome = await executeInteractionCompatibility({
      sessionId: "section-scope-session", operationId: "section-scope-fill", ordinal: 1,
      page: opened.page,
      action: {
        type: "fill", secretRef: "00000000-0000-4000-8000-000000000001",
        target: {
          ...target,
          concept: "interactive API client ID",
          requiredCapabilities: ["focusable", "accepts_text", "editable"],
          preferredEvidence: { ...target.preferredEvidence, roles: ["textbox"], names: [], labels: ["Client ID"] },
          scope: { kind: "section", name: "Create Order" },
        },
      },
      policy: { allowedOrigins: ["https://example.test"], allowPrivateNetwork: false,
        allowDownloads: false, allowPopups: false, maxActions: 1, maxDurationMs: 30_000,
        maxNavigations: 1 },
      privacyGate: privacyGate as never,
      options: {
        outputDirectory: "/tmp/native-section-scope-lifecycle",
        nativeResolutionPolicy: "native_only",
        secretResolver: vi.fn(async () => "protected-canary-never-serialized"),
        executeNativeControl: native,
        onMutationDispatch,
      },
    });
    expect(outcome).toMatchObject({
      functionalResult: "failed",
      mutationOutcome: "not_applied",
      privacyResult: "unverified",
      reasonCode: expect.stringMatching(/^PRAXIS_/),
    });
      expect(native).not.toHaveBeenCalled();
      expect(lifecycle).toEqual([]);
      expect(onMutationDispatch).not.toHaveBeenCalled();
      expect(JSON.stringify(outcome)).not.toContain("protected-canary-never-serialized");
    } finally {
      unregister();
      await opened.context.close();
      await opened.browser.close();
    }
  });

  it("uses an observed dispatch transition, not an error name, to preserve unknown outcome", async () => {
    const onMutationDispatch = vi.fn();
    const outcome = await executeInteractionCompatibility({
      sessionId: "post-dispatch-session", operationId: "post-dispatch-click", ordinal: 1,
      page: {} as never,
      action: { type: "click", target, expectedEffect: { type: "none" } },
      policy: { allowedOrigins: ["https://example.test"], allowPrivateNetwork: false,
        allowDownloads: false, allowPopups: false, maxActions: 1, maxDurationMs: 30_000,
        maxNavigations: 1 },
      options: {
        outputDirectory: "/tmp/native-post-dispatch-lifecycle",
        executeNativeControl: vi.fn(async (_page, _target, _operation, beforeDispatch) => {
          await beforeDispatch?.();
          throw new Error("NATIVE_TARGET_NOT_FOUND");
        }),
        onMutationDispatch,
      },
    });
    expect(outcome).toMatchObject({ functionalResult: "failed", mutationOutcome: "unknown" });
    expect(onMutationDispatch).toHaveBeenCalledOnce();
  });

  it("routes select and check mechanics through Praxis without native Executor control", async () => {
    const opened = await openTestBrowser();
    const unregister = registerPraxisVeilAuthority(opened.page, {
      authority: new VeilAuthority(compileVeilPolicy({ profile: "balanced", allowedOrigins: ["https://example.test"] })),
      userId: "test", environmentId: "test", browserContextId: "form-control-context",
    });
    const native = vi.fn(async () => { throw new Error("FORM_CONTROL_MUST_NOT_USE_NATIVE_EXECUTOR"); });
    const policy = { allowedOrigins: ["https://example.test"], allowPrivateNetwork: false,
      allowDownloads: false as const, allowPopups: false as const, maxActions: 2, maxDurationMs: 30_000,
      maxNavigations: 1 };
    try {
      await opened.page.setContent(`
        <label>Tier<select><option>Basic</option><option>Pro</option></select></label>
        <label><input type="checkbox"> Enabled</label>
      `);
      const select = await executeInteractionCompatibility({
        sessionId: "form-control", operationId: "select", ordinal: 1, page: opened.page,
        action: { type: "select", value: "Pro", target: {
          ...target, concept: "tier", requiredCapabilities: ["selects_option"],
          preferredEvidence: { ...target.preferredEvidence, roles: ["combobox"], names: ["Tier"] },
          risk: "ordinary",
        } },
        policy,
        options: { outputDirectory: "/tmp/praxis-select-check", executeNativeControl: native },
      });
      const check = await executeInteractionCompatibility({
        sessionId: "form-control", operationId: "check", ordinal: 2, page: opened.page,
        action: { type: "check", checked: true, target: {
          ...target, concept: "enabled", requiredCapabilities: ["toggleable"],
          preferredEvidence: { ...target.preferredEvidence, roles: ["checkbox"], names: ["Enabled"] },
          risk: "ordinary",
        } },
        policy,
        options: { outputDirectory: "/tmp/praxis-select-check", executeNativeControl: native },
      });
      expect(select).toMatchObject({ functionalResult: "succeeded", mutationOutcome: "applied" });
      expect(check).toMatchObject({ functionalResult: "succeeded", mutationOutcome: "applied" });
      expect(native).not.toHaveBeenCalled();
      expect(await opened.page.getByRole("combobox", { name: "Tier" }).inputValue()).toBe("Pro");
      expect(await opened.page.getByRole("checkbox", { name: "Enabled" }).isChecked()).toBe(true);
    } finally {
      unregister();
      await opened.context.close();
      await opened.browser.close();
    }
  });

  it("dispatches a standard control through one native resolution with zero Praxis results", async () => {
    const click = vi.fn(async () => undefined);
    const executeNativeControl = vi.fn(async (_page, _target, operation, beforeDispatch) => {
      expect(operation).toMatchObject({
        type: "click",
        timeoutMs: 60_000,
        resolutionTimeoutMs: 100,
      });
      await beforeDispatch?.();
      if (operation.type === "click") await click();
    });
    const onPraxisResult = vi.fn();
    const onMutationDispatch = vi.fn(async () => undefined);
    await executeAction(
      {} as never,
      { type: "click", target, expectedEffect: { type: "none" }, timeoutMs: 60_000 },
      {
        plan: {
          name: "native auth", objective: "sign in", preconditions: [],
          allowedOrigins: ["https://example.test"],
          budgets: { maxActions: 1, maxDurationMs: 30_000, maxNavigations: 1 },
          checkpoints: [], steps: [],
        },
        policy: {
          allowedOrigins: ["https://example.test"], allowPrivateNetwork: false,
          allowDownloads: false, allowPopups: false, maxActions: 1,
          maxDurationMs: 30_000, maxNavigations: 1,
        },
        outputDirectory: "/tmp/native-first-test",
        executeNativeControl,
        onPraxisResult,
        onMutationDispatch,
      },
      new AbortController().signal,
      new SecretRedactor(),
      new Map(),
      new Map(),
    );
    expect(executeNativeControl).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    expect(onMutationDispatch).toHaveBeenCalledOnce();
    expect(onPraxisResult).not.toHaveBeenCalled();
  });

  it("does not invoke Praxis when M2 native-only resolution misses", async () => {
    const praxisSpy = vi.fn();
    await expect(executeAction(
      {} as never,
      { type: "click", target, expectedEffect: { type: "none" } },
      {
        plan: { name: "native only", objective: "resolve", preconditions: [], allowedOrigins: ["https://example.test"], budgets: { maxActions: 1, maxDurationMs: 30_000, maxNavigations: 1 }, checkpoints: [], steps: [] },
        policy: { allowedOrigins: ["https://example.test"], allowPrivateNetwork: false, allowDownloads: false, allowPopups: false, maxActions: 1, maxDurationMs: 30_000, maxNavigations: 1 },
        outputDirectory: "/tmp/native-only-test", nativeResolutionPolicy: "native_only",
        executeNativeControl: vi.fn(async () => { throw new Error("NATIVE_TARGET_NOT_FOUND"); }),
        onPraxisResult: praxisSpy,
      }, new AbortController().signal, new SecretRedactor(), new Map(), new Map(),
    )).rejects.toThrow("NATIVE_TARGET_NOT_FOUND");
    expect(praxisSpy).not.toHaveBeenCalled();
  });

  it.each(["NATIVE_TARGET_NOT_FOUND", "NATIVE_TARGET_AMBIGUOUS"])(
    "falls back to Praxis after %s and dispatches the mutation once",
    async (reasonCode) => {
      const opened = await openTestBrowser();
      const onMutationDispatch = vi.fn(async () => undefined);
      const onPraxisResult = vi.fn();
      const unregister = registerPraxisVeilAuthority(opened.page, {
        authority: new VeilAuthority(compileVeilPolicy({
          profile: "balanced", allowedOrigins: ["https://example.test"],
        })),
        userId: "mission-authoring-test",
        environmentId: "test",
        browserContextId: `context-${reasonCode.toLowerCase()}`,
      });
      try {
        await opened.page.setContent(
          `<button aria-label="Sign in" onclick="this.dataset.clicked='yes'">Sign in</button>`,
        );
        const outcome = await executeInteractionCompatibility({
          sessionId: "mission-authoring-session",
          operationId: `fallback-${reasonCode.toLowerCase()}`,
          page: opened.page,
          action: { type: "click", target, expectedEffect: { type: "none" } },
          ordinal: 1,
          policy: {
            allowedOrigins: ["https://example.test"], allowPrivateNetwork: false,
            allowDownloads: false, allowPopups: false, maxActions: 1,
            maxDurationMs: 30_000, maxNavigations: 1,
          },
          options: {
            outputDirectory: "/tmp/native-praxis-fallback-test",
            executeNativeControl: vi.fn(async () => { throw new Error(reasonCode); }),
            onMutationDispatch,
            onPraxisResult,
          },
        });

        expect(outcome.functionalResult, JSON.stringify(outcome)).toBe("succeeded");
        expect(await opened.page.locator("button").getAttribute("data-clicked")).toBe("yes");
        expect(onPraxisResult).toHaveBeenCalledOnce();
        expect(onMutationDispatch).toHaveBeenCalledOnce();
      } finally {
        unregister();
        await opened.context.close();
        await opened.browser.close();
      }
    },
    30_000,
  );

  it("returns safe semantic distinctions and accepts a revised intent on the same page", async () => {
    const opened = await openTestBrowser();
    const canary = "redacted-candidate-canary-7f13";
    let mutations = 0;
    const unregister = registerPraxisVeilAuthority(opened.page, {
      authority: new VeilAuthority(compileVeilPolicy({
        profile: "balanced", allowedOrigins: ["https://example.test"],
      })),
      userId: "mission-recovery-test",
      environmentId: "test",
      browserContextId: "context-mission-recovery",
    });
    try {
      await opened.page.exposeFunction("recordRecoveryMutation", () => { mutations += 1; });
      await opened.page.setContent(`<table><tbody>
        <tr role="link" tabindex="0" data-id="intended" onclick="recordRecoveryMutation(); this.dataset.clicked='yes'">
          <td>Scry Recovery 39ca1ecb</td><td>Test</td><td>Active</td>
        </tr>
        <tr role="link" tabindex="0" data-id="copy" data-scry-redacted="true" onclick="recordRecoveryMutation(); this.dataset.clicked='yes'">
          <td>Scry Recovery 39ca1ecb copy ${canary}</td><td>Test</td><td>Active</td>
        </tr>
      </tbody></table>`);
      const originalTarget = {
        concept: "created application",
        requiredCapabilities: ["focusable" as const, "pointer_activatable" as const],
        preferredEvidence: {
          roles: ["link" as const], names: ["Scry Recovery 39ca1ecb"], labels: [],
          descriptions: [], placeholders: [], inputTypes: [],
        },
        scope: { kind: "page" as const }, relations: [],
        prohibited: ["hidden" as const, "disabled" as const], risk: "ordinary" as const,
        confidence: { requiredFamilies: [] },
      };
      const praxis = vi.fn();
      const firstMutationDispatch = vi.fn(async () => undefined);
      const nativeMiss = vi.fn(async () => { throw new Error("NATIVE_TARGET_NOT_FOUND"); });
      const first = await executeInteractionCompatibility({
        sessionId: "retained-session", operationId: "original", page: opened.page, ordinal: 1,
        action: { type: "click", target: originalTarget, expectedEffect: { type: "none" } },
        policy: { allowedOrigins: ["https://example.test"], allowPrivateNetwork: false,
          allowDownloads: false, allowPopups: false, maxActions: 2, maxDurationMs: 30_000,
          maxNavigations: 1 },
        options: { outputDirectory: "/tmp/native-revision-test", executeNativeControl: nativeMiss,
          onMutationDispatch: firstMutationDispatch, onPraxisResult: praxis },
      });
      expect(nativeMiss).toHaveBeenCalledOnce();
      expect(praxis).toHaveBeenCalledOnce();
      expect(firstMutationDispatch).not.toHaveBeenCalled();
      expect(mutations).toBe(0);
      expect(first).toMatchObject({
        functionalResult: "failed", mutationOutcome: "not_applied",
        reasonCode: expect.stringMatching(/^PRAXIS_(TARGET_AMBIGUOUS|INSUFFICIENT_EVIDENCE)$/),
        nextDecisionBoundary: { type: "ambiguous_candidate", safeActions: ["advance_flow_authoring"] },
      });
      const serialized = JSON.stringify(first);
      expect(serialized).toContain("contains the requested identity rather than exactly equaling it");
      expect(serialized).toContain("identity suppressed");
      expect(serialized).not.toContain(canary);
      for (const forbidden of ["locator", "selector", "xpath", "runtimeId", "fingerprint",
        "resumeToken", "frame", "path", "bounds", "href", "outerHTML", "innerHTML"]) {
        expect(serialized).not.toContain(forbidden);
      }
      const fullName = first.nextDecisionBoundary?.type === "ambiguous_candidate"
        ? first.nextDecisionBoundary.candidateDistinctions?.find((item) =>
            item.distinction.includes("Scry Recovery 39ca1ecb Test Active"))?.distinction
        : undefined;
      expect(fullName).toBeTruthy();
      const revisedTarget = {
        ...originalTarget,
        preferredEvidence: { ...originalTarget.preferredEvidence,
          names: ["Scry Recovery 39ca1ecb Test Active"] },
      };
      const revisedPraxis = vi.fn();
      const revisedDispatch = vi.fn(async () => undefined);
      const revisedNative = vi.fn(async (page, _target, _operation, beforeDispatch) => {
        await beforeDispatch?.();
        await page.getByRole("link", { name: "Scry Recovery 39ca1ecb Test Active", exact: true }).click();
      });
      const second = await executeInteractionCompatibility({
        sessionId: "retained-session", operationId: "revised", page: opened.page, ordinal: 2,
        action: { type: "click", target: revisedTarget, expectedEffect: { type: "none" } },
        policy: { allowedOrigins: ["https://example.test"], allowPrivateNetwork: false,
          allowDownloads: false, allowPopups: false, maxActions: 2, maxDurationMs: 30_000,
          maxNavigations: 1 },
        options: { outputDirectory: "/tmp/native-revision-test", executeNativeControl: revisedNative,
          onMutationDispatch: revisedDispatch, onPraxisResult: revisedPraxis },
      });
      expect(second.functionalResult).toBe("succeeded");
      expect(await opened.page.locator('[data-id="intended"]').getAttribute("data-clicked")).toBe("yes");
      expect(await opened.page.locator('[data-id="copy"]').getAttribute("data-clicked")).toBeNull();
      expect(mutations).toBe(1);
      expect(revisedDispatch).toHaveBeenCalledOnce();
      expect(revisedPraxis).not.toHaveBeenCalled();
    } finally {
      unregister();
      await opened.context.close();
      await opened.browser.close();
    }
  }, 30_000);

  it("uses set cardinality for Praxis state observation while clicks remain ambiguous", async () => {
    const opened = await openTestBrowser();
    const canary = "dialog-observation-canary-4c91";
    const onMutationDispatch = vi.fn(async () => undefined);
    const unregister = registerPraxisVeilAuthority(opened.page, {
      authority: new VeilAuthority(compileVeilPolicy({
        profile: "balanced", allowedOrigins: ["https://example.test"],
      })),
      userId: "dialog-observation-test",
      environmentId: "test",
      browserContextId: "context-dialog-observation",
    });
    const dialogTarget = {
      concept: "add credential dialog",
      requiredCapabilities: ["readable_value" as const],
      preferredEvidence: {
        roles: ["dialog" as const], names: ["Add credential"], labels: [], descriptions: [],
        placeholders: [], inputTypes: [],
      },
      scope: { kind: "page" as const }, relations: [],
      prohibited: ["hidden" as const, "disabled" as const],
      risk: "read_only" as const, confidence: { requiredFamilies: [] },
    };
    const policy = { allowedOrigins: ["https://example.test"], allowPrivateNetwork: false,
      allowDownloads: false as const, allowPopups: false as const, maxActions: 5,
      maxDurationMs: 30_000, maxNavigations: 1 };
    let ordinal = 0;
    const run = (action: Parameters<typeof executeInteractionCompatibility>[0]["action"], praxis = vi.fn()) =>
      executeInteractionCompatibility({
        sessionId: "dialog-observation", operationId: `observe-${++ordinal}`,
        page: opened.page, ordinal, action, policy,
        options: {
          outputDirectory: "/tmp/praxis-dialog-observation",
          executeNativeControl: vi.fn(async () => { throw new Error("NATIVE_TARGET_AMBIGUOUS"); }),
          onMutationDispatch, onPraxisResult: praxis,
        },
      });
    try {
      await opened.page.setContent(`
        <div role="dialog" tabindex="0" aria-label="Add credential">First</div>
        <div data-scry-redacted="true"><div role="dialog" tabindex="0" aria-label="Add credential">Second ${canary}</div></div>`);
      const visiblePraxis = vi.fn();
      const visible = await run({ type: "waitFor", target: dialogTarget, state: "visible", timeoutMs: 1_000 }, visiblePraxis);
      expect(visible.functionalResult, JSON.stringify(visible)).toBe("succeeded");
      expect(visiblePraxis).toHaveBeenCalledOnce();
      expect(onMutationDispatch).not.toHaveBeenCalled();
      const attachedPraxis = vi.fn();
      const attached = await run({
        type: "waitFor", target: dialogTarget, state: "attached", timeoutMs: 1_000,
      }, attachedPraxis);
      expect(attached.functionalResult, JSON.stringify(attached)).toBe("succeeded");
      expect(attachedPraxis).toHaveBeenCalledOnce();
      expect(onMutationDispatch).not.toHaveBeenCalled();

      const hidden = await run({
        type: "waitFor", target: dialogTarget, state: "hidden", timeoutMs: 1_000,
      });
      expect(hidden).toMatchObject({ functionalResult: "failed", mutationOutcome: "not_applied" });
      expect(hidden.reasonCode).toMatch(
        /^PRAXIS_(TARGET_AMBIGUOUS|INSUFFICIENT_EVIDENCE|TRANSACTION_TIMED_OUT)$/,
      );
      expect(onMutationDispatch).not.toHaveBeenCalled();

      await opened.page.setContent("<main>No matching dialog</main>");
      const detached = await run({
        type: "waitFor", target: dialogTarget, state: "detached", timeoutMs: 1_000,
      });
      expect(detached).toMatchObject({ functionalResult: "failed", mutationOutcome: "not_applied" });
      expect(onMutationDispatch).not.toHaveBeenCalled();
      await opened.page.setContent(`
        <div role="dialog" tabindex="0" aria-label="Add credential">First</div>
        <div role="dialog" tabindex="0" aria-label="Add credential">Second</div>`);
      const click = await run({ type: "click", target: {
        ...dialogTarget, requiredCapabilities: ["focusable", "pointer_activatable"], risk: "ordinary",
      }, expectedEffect: { type: "none" } });
      expect(click).toMatchObject({ functionalResult: "failed", mutationOutcome: "not_applied" });
      expect(click.reasonCode).toMatch(/^PRAXIS_(TARGET_AMBIGUOUS|INSUFFICIENT_EVIDENCE)$/);
      expect(onMutationDispatch).not.toHaveBeenCalled();
      const serialized = JSON.stringify({ visible, attached, hidden, detached, click });
      expect(serialized).not.toContain(canary);
      for (const forbidden of ["locator", "selector", "xpath", "runtimeId", "fingerprint",
        "resumeToken", "path", "bounds", "outerHTML", "innerHTML"]) {
        expect(serialized).not.toContain(forbidden);
      }
    } finally {
      unregister();
      await opened.context.close();
      await opened.browser.close();
    }
  }, 30_000);

  it("keeps the privacy gate reusable when protected resolution fails before dispatch", async () => {
    const opened = await openTestBrowser();
    const secretCanary = "protected-fill-secret-canary-91d4";
    const collector = (): PrivacyCollector => {
      let status: ReturnType<PrivacyCollector["state"]>["status"] = "active";
      return {
        name: "protected-fill-test",
        arm: vi.fn(async () => { status = "prepared"; }),
        suspend: vi.fn(async () => { status = "suspended"; }),
        isolate: vi.fn(async () => { status = "isolated"; }),
        resume: vi.fn(async () => { status = "active"; }),
        seal: vi.fn(async () => { status = "sealed"; }),
        finalize: vi.fn(async () => { status = "finalized"; }),
        state: () => ({ status }),
      };
    };
    const privacyGate = new VeilRuntimeCoordinator([collector()]);
    const unregister = registerPraxisVeilAuthority(opened.page, {
      authority: new VeilAuthority(compileVeilPolicy({
        profile: "balanced", allowedOrigins: ["https://example.test"],
      })),
      userId: "protected-fill-test",
      environmentId: "test",
      browserContextId: "context-protected-fill",
    });
    try {
      await opened.page.setContent(`
        <label>Email address primary <input type="text" aria-label="Email address primary"></label>
        <label>Email address secondary <input type="text" aria-label="Email address secondary"></label>
      `);
      const praxis = vi.fn();
      const mutationDispatch = vi.fn(async () => undefined);
      const outcome = await executeInteractionCompatibility({
        sessionId: "protected-fill-session", operationId: "protected-fill", ordinal: 1,
        page: opened.page,
        action: {
          type: "fill", secretRef: "00000000-0000-4000-8000-000000000001",
          target: {
            concept: "login email",
            requiredCapabilities: ["focusable", "accepts_text", "editable"],
            preferredEvidence: {
              roles: ["textbox"], names: ["Email address"], labels: [], descriptions: [],
              placeholders: [], inputTypes: ["text"],
            },
            scope: { kind: "page" }, relations: [], prohibited: ["hidden", "disabled"],
            risk: "authentication", confidence: { requiredFamilies: [] },
          },
        },
        policy: { allowedOrigins: ["https://example.test"], allowPrivateNetwork: false,
          allowDownloads: false, allowPopups: false, maxActions: 1, maxDurationMs: 30_000,
          maxNavigations: 1 },
        privacyGate,
        options: {
          outputDirectory: "/tmp/native-protected-fill-fallback-test",
          secretResolver: vi.fn(async () => secretCanary),
          executeNativeControl: vi.fn(async () => { throw new Error("NATIVE_TARGET_NOT_FOUND"); }),
          onPraxisResult: praxis,
          onMutationDispatch: mutationDispatch,
        },
      });
      expect(praxis).toHaveBeenCalledOnce();
      expect(mutationDispatch).not.toHaveBeenCalled();
      expect(outcome).toMatchObject({
        functionalResult: "failed", mutationOutcome: "not_applied",
        privacyResult: "unverified",
        reasonCode: expect.stringMatching(/^PRAXIS_(TARGET_AMBIGUOUS|INSUFFICIENT_EVIDENCE)$/),
        nextDecisionBoundary: { type: "ambiguous_candidate" },
      });
      expect(JSON.stringify(outcome)).not.toContain(secretCanary);
      expect(privacyGate.state()).toBe("normal");

      const revisedNative = vi.fn(async () => {
        throw new Error("PROTECTED_FILL_MUST_NOT_USE_NATIVE_EXECUTOR");
      });
      const revised = await executeInteractionCompatibility({
        sessionId: "protected-fill-session", operationId: "protected-fill-revised", ordinal: 2,
        page: opened.page,
        action: {
          type: "fill", secretRef: "00000000-0000-4000-8000-000000000001",
          target: {
            concept: "primary login email",
            requiredCapabilities: ["focusable", "accepts_text", "editable"],
            preferredEvidence: {
              roles: ["textbox"], names: ["Email address primary"], labels: [], descriptions: [],
              placeholders: [], inputTypes: ["text"],
            },
            scope: { kind: "page" }, relations: [], prohibited: ["hidden", "disabled"],
            risk: "authentication", confidence: { requiredFamilies: [] },
          },
        },
        policy: { allowedOrigins: ["https://example.test"], allowPrivateNetwork: false,
          allowDownloads: false, allowPopups: false, maxActions: 1, maxDurationMs: 30_000,
          maxNavigations: 1 },
        privacyGate,
        options: {
          outputDirectory: "/tmp/native-protected-fill-revision-test",
          secretResolver: vi.fn(async () => secretCanary),
          executeNativeControl: revisedNative,
          onMutationDispatch: mutationDispatch,
        },
      });
      expect(revised).toMatchObject({
        functionalResult: "succeeded", mutationOutcome: "applied", privacyResult: "verified",
      });
      expect(mutationDispatch).toHaveBeenCalledOnce();
      expect(revisedNative).not.toHaveBeenCalled();
      expect(privacyGate.state()).toBe("normal");
      expect(await opened.page.getByLabel("Email address primary").inputValue()).toBe(secretCanary);
      expect(JSON.stringify(revised)).not.toContain(secretCanary);
    } finally {
      unregister();
      await opened.context.close();
      await opened.browser.close();
    }
  }, 30_000);

  it.each([
    { renderDelayMs: 1_200 },
    { renderDelayMs: 2_000 },
    { renderDelayMs: 3_000 },
  ])(
    "keeps ordinary action resolution available when a textbox renders after $renderDelayMs ms",
    async ({ renderDelayMs }) => {
      const opened = await openTestBrowser();
      const unregister = registerPraxisVeilAuthority(opened.page, {
        authority: new VeilAuthority(compileVeilPolicy({
          profile: "balanced", allowedOrigins: ["https://example.test"],
        })),
        userId: "delayed-login-characterization",
        environmentId: "test",
        browserContextId: `context-delayed-login-${renderDelayMs}`,
      });
      const praxis = vi.fn();
      const mutationDispatch = vi.fn(async () => undefined);
      try {
        await opened.page.setContent(`<main aria-label="Login loading"></main><script>
          setTimeout(() => {
            document.querySelector('main').innerHTML =
              '<input type="email" placeholder="Enter your email" aria-label="Email">';
          }, ${renderDelayMs});
        </script>`);
        const startedAt = performance.now();
        const outcome = await executeInteractionCompatibility({
          sessionId: "delayed-login-session",
          operationId: `delayed-login-${renderDelayMs}`,
          page: opened.page,
          ordinal: 1,
          action: {
            type: "fill",
            value: "safe-public-characterization-value",
            timeoutMs: 60_000,
            target: {
              concept: "login email",
              requiredCapabilities: ["focusable", "accepts_text", "editable"],
              preferredEvidence: {
                roles: ["textbox"], names: [], labels: [], descriptions: [],
                placeholders: ["Enter your email"], inputTypes: ["email"],
              },
              scope: { kind: "page" }, relations: [], prohibited: ["hidden", "disabled"],
              risk: "authentication", confidence: { requiredFamilies: [] },
            },
          },
          policy: {
            allowedOrigins: ["https://example.test"], allowPrivateNetwork: false,
            allowDownloads: false, allowPopups: false, maxActions: 1,
            maxDurationMs: 60_000, maxNavigations: 1,
          },
          options: {
            outputDirectory: "/tmp/delayed-login-characterization",
            executeNativeControl: vi.fn(async (page, _target, operation, beforeDispatch) => {
              const deadline = performance.now() + (operation.resolutionTimeoutMs ?? 0);
              do {
                const input = page.getByPlaceholder("Enter your email");
                if (await input.count()) {
                  await beforeDispatch?.();
                  if (operation.type === "fill") await input.fill(operation.value);
                  return;
                }
                await new Promise((resolve) => setTimeout(resolve, 50));
              } while (performance.now() < deadline);
              throw new Error("NATIVE_TARGET_NOT_FOUND");
            }),
            onPraxisResult: praxis,
            onMutationDispatch: mutationDispatch,
          },
        });
        const durationMs = performance.now() - startedAt;
        expect(outcome.functionalResult).toBe("succeeded");
        expect(praxis).toHaveBeenCalled();
        expect(praxis.mock.calls.at(-1)?.[0]).toMatchObject({ status: "succeeded" });
        expect(mutationDispatch).toHaveBeenCalledOnce();
        expect(await opened.page.getByPlaceholder("Enter your email").inputValue())
          .toBe("safe-public-characterization-value");
        expect(durationMs).toBeLessThan(5_000);
      } finally {
        unregister();
        await opened.context.close();
        await opened.browser.close();
      }
    },
    15_000,
  );

  it("contains current-browser-session tokens inside a Veil protected interval", async () => {
    const tokenCanary = "bearer-token-must-never-serialize";
    const lifecycle: string[] = [];
    const callbackValues: unknown[] = [];
    const privacyGate = {
      prepare: vi.fn(async () => { lifecycle.push("prepare"); }),
      beginProtected: vi.fn(async () => { lifecycle.push("protected"); }),
      markCaptured: vi.fn(async () => { lifecycle.push("captured"); }),
      beginSafeBoundary: vi.fn(async () => { lifecycle.push("safe-boundary"); }),
      confirmSafeBoundary: vi.fn(async () => { lifecycle.push("confirmed"); }),
      seal: vi.fn(async () => { lifecycle.push("sealed"); }),
    };
    const artifacts: unknown[] = [];
    const events: unknown[] = [];
    const outcome = await executeInteractionCompatibility({
      sessionId: "session", operationId: "operation", ordinal: 1,
      page: { url: () => "https://example.test/account" } as never,
      action: {
        type: "sameOriginRequest", method: "DELETE", path: "/users/me",
        expectedStatus: { min: 200, max: 204 }, authentication: "current_browser_session",
      },
      policy: { allowedOrigins: ["https://example.test"], allowPrivateNetwork: false, allowDownloads: false, allowPopups: false, maxActions: 1, maxDurationMs: 30_000, maxNavigations: 1 },
      privacyGate: privacyGate as never,
      options: {
        outputDirectory: "/tmp/native-request-test",
        executeSameOriginRequest: vi.fn(async (_page, request, _origins, beforeDispatch) => {
          callbackValues.push(request, false);
          await beforeDispatch?.();
          return { status: 204, classification: "expected" as const };
        }),
      },
    });
    expect(lifecycle).toEqual(["prepare", "protected", "captured", "safe-boundary", "confirmed"]);
    expect(outcome.privacyResult).toBe("verified");
    expect(JSON.stringify({ events, artifacts, callbackValues, outcome })).not.toContain(tokenCanary);
  });

  it("seals the protected interval when a same-origin request fails", async () => {
    const lifecycle: string[] = [];
    const privacyGate = {
      prepare: vi.fn(async () => { lifecycle.push("prepare"); }),
      beginProtected: vi.fn(async () => { lifecycle.push("protected"); }),
      markCaptured: vi.fn(async () => { lifecycle.push("captured"); }),
      beginSafeBoundary: vi.fn(async () => { lifecycle.push("safe-boundary"); }),
      confirmSafeBoundary: vi.fn(async () => { lifecycle.push("confirmed"); }),
      seal: vi.fn(async () => { lifecycle.push("sealed"); }),
    };
    const outcome = await executeInteractionCompatibility({
      sessionId: "session", operationId: "operation", ordinal: 1, page: { url: () => "https://example.test" } as never,
      action: { type: "sameOriginRequest", method: "DELETE", path: "/users/me", expectedStatus: { min: 204, max: 204 }, authentication: "current_browser_session" },
      policy: { allowedOrigins: ["https://example.test"], allowPrivateNetwork: false, allowDownloads: false, allowPopups: false, maxActions: 1, maxDurationMs: 30_000, maxNavigations: 1 },
      privacyGate: privacyGate as never,
      options: { outputDirectory: "/tmp/native-request-failure", executeSameOriginRequest: vi.fn(async () => { throw new Error("NATIVE_SAME_ORIGIN_STATUS_UNEXPECTED"); }) },
    });
    expect(lifecycle).toEqual(["prepare", "protected", "sealed"]);
    expect(outcome.privacyResult).toBe("sealed");
  });
});
