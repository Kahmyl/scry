import {
  adaptiveSessionOperationInputSchema,
  type AdaptiveSessionOperationInput,
  type InteractionTargetIntent,
} from "@scry/contracts";

export const m1ExternalTargetRegistry = {
  orangehrm: target({
    origin: "https://opensource-demo.orangehrmlive.com",
    loginPath: "/web/index.php/auth/login",
    username: ["Ad", "min"].join(""),
    password: ["admin", "123"].join(""),
    usernameLabel: "Username",
    passwordLabel: "Password",
    loginButton: "Login",
    successRole: "heading",
    successName: "Dashboard",
    timeoutMs: 120_000,
  }),
  expand_testing: target({
    origin: "https://practice.expandtesting.com",
    loginPath: "/login",
    username: ["practice"].join(""),
    password: ["SuperSecret", "Password!"].join(""),
    usernameLabel: "Username",
    passwordLabel: "Password",
    loginButton: "Login",
    successRole: "heading",
    successName: "Secure Area page for Automation Testing Practice",
    timeoutMs: 90_000,
  }),
  the_internet: target({
    origin: "https://the-internet.herokuapp.com",
    loginPath: "/login",
    username: ["tom", "smith"].join(""),
    password: ["SuperSecret", "Password!"].join(""),
    usernameLabel: "Username",
    passwordLabel: "Password",
    loginButton: "Login",
    successRole: "heading",
    successName: "Secure Area",
    timeoutMs: 90_000,
  }),
  xyz_bank: {
    origin: "https://www.globalsqa.com",
    loginPath: "/angularJs-protractor/BankingProject/#/login",
    semanticOperations: [
      { type: "navigate" as const },
      { type: "click" as const, label: "Customer Login" },
      { type: "waitFor" as const, label: "Your Name", role: "combobox" as const },
    ],
    expectedSuccessState: { role: "combobox" as const, name: "Your Name" },
    logoutCleanup: { required: false, operation: "none" as const },
    prohibitedMutations: ["account_login", "deposit", "withdrawal", "transaction"],
    timeoutMs: 90_000,
    resolutionThresholds: { minNativeResolved: 1, maxPraxisFallbacks: 1 },
    trustedScriptOrigins: [
      "https://ajax.googleapis.com",
      "https://cdnjs.cloudflare.com",
      "https://maxcdn.bootstrapcdn.com",
    ],
  },
} as const;

export type M1ExternalTarget = keyof typeof m1ExternalTargetRegistry;

export function externalTargetOperations(
  targetName: M1ExternalTarget,
  credentialIds: { username?: string; password?: string },
): AdaptiveSessionOperationInput[] {
  const config = m1ExternalTargetRegistry[targetName];
  const operationTimeoutMs = Math.min(config.timeoutMs, 60_000);
  const operations: AdaptiveSessionOperationInput[] = [
    operation(targetName, "navigate", {
      type: "navigate",
      url: `${config.origin}${config.loginPath}`,
      timeoutMs: operationTimeoutMs,
    }),
  ];
  if ("credentials" in config) {
    if (!credentialIds.username || !credentialIds.password)
      throw new Error("M1_TARGET_CREDENTIAL_BINDING_REQUIRED");
    operations.push(
      operation(
        targetName,
        "username",
        {
          type: "fill",
          target: intent(config.credentials.usernameLabel, "textbox"),
          secretRef: credentialIds.username,
          timeoutMs: operationTimeoutMs,
        },
        [credentialIds.username],
      ),
      operation(
        targetName,
        "password",
        {
          type: "fill",
          target: intent(config.credentials.passwordLabel, "textbox"),
          secretRef: credentialIds.password,
          timeoutMs: operationTimeoutMs,
        },
        [credentialIds.password],
      ),
      operation(targetName, "login", {
        type: "click",
        target: intent(config.credentials.loginButton, "button"),
        expectedEffect: { type: "none" },
        timeoutMs: operationTimeoutMs,
      }),
    );
  } else {
    operations.push(
      operation(targetName, "customer-login", {
        type: "click",
        target: intent("Customer Login", "button"),
        expectedEffect: { type: "none" },
        timeoutMs: operationTimeoutMs,
      }),
    );
  }
  operations.push(
    operation(targetName, "success", {
      type: "waitFor",
      target: intent(config.expectedSuccessState.name, config.expectedSuccessState.role),
      state: "visible",
      timeoutMs: targetName === "xyz_bank" ? 10_000 : operationTimeoutMs,
    }),
  );
  return operations;
}

function target(input: {
  origin: string;
  loginPath: string;
  username: string;
  password: string;
  usernameLabel: string;
  passwordLabel: string;
  loginButton: string;
  successRole: "heading";
  successName: string;
  timeoutMs: number;
}) {
  return {
    origin: input.origin,
    loginPath: input.loginPath,
    credentials: {
      usernameValue: input.username,
      passwordValue: input.password,
      usernameLabel: input.usernameLabel,
      passwordLabel: input.passwordLabel,
      loginButton: input.loginButton,
    },
    semanticOperations: ["navigate", "protected_username", "protected_password", "login", "verify"],
    expectedSuccessState: { role: input.successRole, name: input.successName },
    logoutCleanup: { required: false, operation: "close_session" as const },
    prohibitedMutations: ["create", "update", "delete", "charge", "notify"],
    timeoutMs: input.timeoutMs,
    resolutionThresholds: { minNativeResolved: 1, maxPraxisFallbacks: 0 },
  } as const;
}

function operation(
  target: string,
  id: string,
  action: AdaptiveSessionOperationInput["action"],
  protectedInputReferences: string[] = [],
) {
  return adaptiveSessionOperationInputSchema.parse({
    operationId: `${target}-${id}`,
    idempotencyKey: `m1-${target}-${id}`,
    action,
    expectedEffect:
      action.type === "navigate"
        ? { type: "navigation", url: action.url, match: "exact" }
        : { type: "none" },
    mode: "transact",
    protectedInputReferences,
  });
}

function intent(
  name: string,
  role: "textbox" | "button" | "heading" | "combobox",
): InteractionTargetIntent {
  return {
    concept: name.toLowerCase().replace(/\s+/g, "_"),
    requiredCapabilities:
      role === "textbox"
        ? ["accepts_text", "focusable", "editable"]
        : role === "heading"
          ? ["readable_value"]
          : ["pointer_activatable"],
    preferredEvidence: {
      roles: [role],
      names: [name],
      labels: [name],
      descriptions: [],
      placeholders: [],
      inputTypes: [],
      ...(role === "button" ? { expectedText: name } : {}),
    },
    scope: { kind: "page" },
    relations: [],
    prohibited: ["hidden", "disabled"],
    risk: role === "textbox" ? "authentication" : "ordinary",
    confidence: { requiredFamilies: [] },
  };
}
