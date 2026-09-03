import {
  missionAuthoringIntentSchema,
  type MissionAuthoringIntent,
  type MissionAuthoringSemanticTarget,
} from "@scry/contracts";

import type { M2FlowDefinition, M2Ownership } from "./mission-live-m2-support.js";

export const m2ExternalTargets = [
  "automation_exercise",
  "demoblaze",
  "xyz_bank",
  "contact_list",
] as const;

export type M2ExternalTarget = (typeof m2ExternalTargets)[number];

export const m2TargetRegistry = {
  automation_exercise: {
    origin: "https://automationexercise.com",
    mission: "M2 Automation Exercise multi-flow cart inspection",
    flows: [
      flow("products", "Open and search Products", "Open Products and search one product", "setup"),
      flow("cart_add", "Add reversible cart items", "Add two products to cart", "primary", true),
      flow(
        "cart_inspect",
        "Inspect cart totals",
        "Inspect both cart rows and totals",
        "acceptance",
      ),
      flow("cleanup", "Empty campaign cart", "Remove both campaign cart items", "cleanup", true),
      flow("test_cases", "Inspect Test Cases", "Open the Test Cases page", "diagnostic"),
    ],
    cleanupRefs: ["cart-empty"],
  },
  demoblaze: {
    origin: "https://www.demoblaze.com",
    mission: "M2 DemoBlaze multi-flow storefront inspection",
    flows: [
      flow("browse", "Browse product categories", "Inspect Phones and Laptops", "setup"),
      flow(
        "cart_add",
        "Add a reversible cart item",
        "Add one product and inspect cart",
        "primary",
        true,
      ),
      flow("cleanup", "Empty campaign cart", "Delete the campaign cart item", "cleanup", true),
      flow(
        "modals",
        "Inspect account and contact modals",
        "Open and close login and contact modals",
        "diagnostic",
      ),
    ],
    cleanupRefs: ["cart-item-deleted"],
  },
  xyz_bank: {
    origin: "https://www.globalsqa.com",
    mission: "M2 XYZ Bank multi-flow account inspection",
    flows: [
      flow(
        "customer",
        "Inspect a customer account",
        "Log in as a customer and inspect account details",
        "primary",
      ),
      flow(
        "transactions",
        "Inspect customer transactions",
        "Open transactions and return",
        "acceptance",
      ),
      flow("logout", "Close customer session", "Log out from the customer account", "cleanup"),
      flow(
        "manager",
        "Inspect manager customer records",
        "Open manager Customers without adding data",
        "diagnostic",
      ),
    ],
    cleanupRefs: ["customer-logout"],
  },
  contact_list: {
    origin: "https://thinking-tester-contact-list.herokuapp.com",
    mission: "M2 Contact List disposable CRUD campaign",
    flows: [
      flow(
        "user",
        "Create disposable test user",
        "Create and authenticate a disposable user",
        "setup",
        true,
      ),
      flow(
        "create_contact",
        "Create disposable contact",
        "Create one campaign contact",
        "primary",
        true,
      ),
      flow("read_contact", "Read disposable contact", "Inspect the created contact", "acceptance"),
      flow(
        "update_contact",
        "Update disposable contact",
        "Update and verify the campaign contact",
        "reconciliation",
        true,
      ),
      flow(
        "delete_contact",
        "Delete disposable contact",
        "Delete the campaign contact",
        "cleanup",
        true,
      ),
      flow(
        "delete_user",
        "Delete disposable test user",
        "Delete the user through DELETE /users/me",
        "cleanup",
        true,
      ),
    ],
    cleanupRefs: ["contact-deleted", "user-deleted"],
  },
} as const satisfies Record<
  M2ExternalTarget,
  {
    origin: string;
    mission: string;
    flows: readonly M2FlowDefinition[];
    cleanupRefs: readonly string[];
  }
>;

export function coreM2Flows(): M2FlowDefinition[] {
  return [
    flow("authenticate", "Authenticate to fixture", "Sign in to Partner Portal", "setup"),
    flow("controls", "Use custom controls", "Open controls and select Test Mode", "primary"),
    flow("details", "Navigate to details", "Continue to deterministic details", "acceptance"),
    flow("proof", "Verify terminal proof", "Inspect deterministic success state", "diagnostic"),
  ];
}

export function coreM2Intents(input: {
  origin: string;
  ownership: M2Ownership;
  emailCredentialId: string;
  passwordCredentialId: string;
}): MissionAuthoringIntent[][] {
  const auth = owner(input.ownership, "authenticate");
  const controls = owner(input.ownership, "controls");
  const details = owner(input.ownership, "details");
  const proof = owner(input.ownership, "proof");
  return [
    [
      intent(
        auth,
        "fixture-open",
        { kind: "navigate", url: input.origin },
        navigation(input.origin, "exact"),
      ),
      protectedFill(
        auth,
        "fixture-email",
        target("email", { role: "textbox", label: "Email" }),
        input.emailCredentialId,
      ),
      protectedFill(
        auth,
        "fixture-password",
        target("password", { role: "textbox", label: "Password" }),
        input.passwordCredentialId,
      ),
      intent(
        auth,
        "fixture-sign-in",
        {
          kind: "activate",
          semanticEffect: "unknown",
          target: target("sign in", { role: "button", name: "Sign in" }),
        },
        visible(target("partner portal", { role: "heading", name: "Partner Portal" })),
        "authentication",
      ),
      inspect(
        auth,
        "fixture-portal",
        target("partner portal", { role: "heading", name: "Partner Portal" }),
      ),
      intent(controls, "fixture-open-controls", {
        kind: "activate",
        semanticEffect: "unknown",
        target: target("open controls", { role: "button", name: "Open controls" }),
      }),
      intent(
        controls,
        "fixture-open-environment",
        {
          kind: "activate",
          semanticEffect: "unknown",
          target: target("environment", { role: "combobox", text: "Choose environment" }),
        },
        visible(target("test mode option", { role: "option", name: "Test Mode" })),
      ),
      intent(
        controls,
        "fixture-test-mode",
        {
          kind: "activate",
          semanticEffect: "unknown",
          target: target("test mode option", { role: "option", name: "Test Mode" }),
        },
        state(target("continue", { role: "button", name: "Continue" }), { enabled: true }),
      ),
      intent(
        details,
        "fixture-continue",
        {
          kind: "activate",
          semanticEffect: "unknown",
          target: target("continue", { role: "button", name: "Continue" }),
        },
        navigation(`${input.origin}/details`, "exact"),
      ),
      inspect(
        details,
        "fixture-details",
        target("execution complete", { role: "heading", name: "Execution complete" }),
      ),
      inspect(
        proof,
        "fixture-proof",
        target("deterministic result", { testId: "deterministic-result", text: "fixture-success" }),
      ),
    ],
  ];
}

export function vitractM2Flows(): M2FlowDefinition[] {
  return [
    flow("authenticate", "Authenticate", "Sign in to Partner Portal", "setup"),
    flow(
      "developer",
      "Inspect Test developer controls",
      "Open Developer and select Test Mode",
      "primary",
    ),
    flow(
      "credential",
      "Reach credential boundary",
      "Create a Test application and open Add credential without generation",
      "acceptance",
      true,
    ),
  ];
}

export function vitractRecoveryApplicationName(ownership: M2Ownership) {
  return `Scry Recovery ${ownership.missionId.slice(0, 8)}`;
}

export function vitractM2Intents(input: {
  ownership: M2Ownership;
  emailCredentialId: string;
  passwordCredentialId: string;
}): MissionAuthoringIntent[][] {
  const auth = owner(input.ownership, "authenticate");
  const developer = owner(input.ownership, "developer");
  const credential = owner(input.ownership, "credential");
  const applicationName = vitractRecoveryApplicationName(input.ownership);
  return [
    [
      intent(
        auth,
        "vitract-open-login",
        { kind: "navigate", url: "https://preview.vitract.com/login" },
        navigation("https://preview.vitract.com/login", "exact"),
      ),
      protectedFill(
        auth,
        "vitract-email",
        target("login email", { role: "textbox", placeholder: "Enter your email" }),
        input.emailCredentialId,
      ),
      protectedFill(
        auth,
        "vitract-password",
        target("login password", { role: "textbox", placeholder: "Enter your password" }),
        input.passwordCredentialId,
      ),
      intent(
        auth,
        "vitract-login",
        {
          kind: "activate",
          semanticEffect: "unknown",
          target: target("login", { role: "button", name: "Login" }),
        },
        navigation("https://preview.vitract.com/partner", "path"),
        "authentication",
      ),
      inspect(
        auth,
        "vitract-partner",
        target("partner portal", { role: "heading", name: "Dashboard" }),
      ),
      intent(
        developer,
        "vitract-developer",
        {
          kind: "activate",
          semanticEffect: "unknown",
          target: target("developer", { role: "link", name: "Developer" }),
        },
        navigation("https://preview.vitract.com/partner/developer", "path"),
      ),
      intent(developer, "vitract-test-mode", {
        kind: "activate",
        semanticEffect: "unknown",
        target: target("test mode", { role: "button", name: "Test mode" }),
      }),
      intent(
        credential,
        "vitract-applications",
        {
          kind: "activate",
          semanticEffect: "unknown",
          target: target("applications", { role: "link", name: "Applications" }),
        },
        navigation("https://preview.vitract.com/partner/developer/applications", "path"),
      ),
      inspect(
        credential,
        "vitract-applications-heading",
        target("applications heading", { role: "heading", name: "Applications" }),
      ),
      intent(
        credential,
        "vitract-new-application",
        {
          kind: "activate",
          semanticEffect: "unknown",
          target: target("new application", { role: "link", name: "New application" }),
        },
        navigation("https://preview.vitract.com/partner/developer/applications/new", "path"),
      ),
      publicFill(
        credential,
        "vitract-application-name",
        target("application name", { role: "textbox", label: "Name" }),
        applicationName,
      ),
      mutation(
        credential,
        "vitract-save-application",
        {
          kind: "activate",
          semanticEffect: "unknown",
          target: target("save application", { role: "button", name: "Save" }),
        },
        navigation("https://preview.vitract.com/partner/developer/applications", "path"),
      ),
      intent(
        credential,
        "vitract-created-application",
        {
          kind: "activate",
          semanticEffect: "unknown",
          target: target("created application", { role: "link", name: applicationName }),
        },
        visible(target("application credentials", { role: "link", name: "Credentials" })),
      ),
      intent(
        credential,
        "vitract-credentials",
        {
          kind: "activate",
          semanticEffect: "unknown",
          target: target("application credentials", { role: "link", name: "Credentials" }),
        },
        visible(target("add credential", { role: "button", name: "Add credential" })),
      ),
      intent(
        credential,
        "vitract-add-credential",
        {
          kind: "activate",
          semanticEffect: "unknown",
          target: target("add credential", { role: "button", name: "Add credential" }),
        },
        visible(target("add credential dialog", { role: "dialog", name: "Add credential" })),
      ),
    ],
  ];
}

export function externalM2Intents(input: {
  target: M2ExternalTarget;
  ownership: M2Ownership;
  credentialIds?: Record<string, string>;
  campaignPrefix: string;
}): MissionAuthoringIntent[][] {
  switch (input.target) {
    case "automation_exercise":
      return automationExerciseIntents(input.ownership);
    case "demoblaze":
      return demoBlazeIntents(input.ownership);
    case "xyz_bank":
      return xyzBankIntents(input.ownership);
    case "contact_list":
      return contactListIntents(input.ownership, input.credentialIds ?? {}, input.campaignPrefix);
  }
}

function automationExerciseIntents(ownership: M2Ownership): MissionAuthoringIntent[][] {
  const products = owner(ownership, "products");
  const add = owner(ownership, "cart_add");
  const cart = owner(ownership, "cart_inspect");
  const cleanup = owner(ownership, "cleanup");
  const tests = owner(ownership, "test_cases");
  return [
    [
      intent(
        products,
        "ae-products",
        { kind: "navigate", url: "https://automationexercise.com/products" },
        navigation("https://automationexercise.com/products", "exact"),
      ),
      inspect(
        products,
        "ae-products-heading",
        target("all products", { role: "heading", name: "All Products" }),
      ),
      publicFill(
        products,
        "ae-search",
        target("search product", { role: "textbox", placeholder: "Search Product" }),
        "Blue Top",
      ),
      intent(
        products,
        "ae-submit-search",
        {
          kind: "activate",
          semanticEffect: "unknown",
          target: target("submit search", {
            role: "button",
            testId: "submit_search",
            name: "Search",
          }),
        },
        visible(target("searched products", { role: "heading", name: "Searched Products" })),
      ),
      intent(
        add,
        "ae-product-one",
        { kind: "navigate", url: "https://automationexercise.com/product_details/1" },
        navigation("https://automationexercise.com/product_details/1", "exact"),
        "live_mutation",
      ),
      mutation(
        add,
        "ae-add-one",
        {
          kind: "activate",
          semanticEffect: "unknown",
          target: target("add first product", { role: "button", name: "Add to cart" }),
        },
        visible(target("added confirmation", { text: "Added!" })),
      ),
      mutation(add, "ae-continue-one", {
        kind: "activate",
        semanticEffect: "unknown",
        target: target("continue shopping", { role: "button", name: "Continue Shopping" }),
      }),
      intent(
        add,
        "ae-product-two",
        { kind: "navigate", url: "https://automationexercise.com/product_details/2" },
        navigation("https://automationexercise.com/product_details/2", "exact"),
        "live_mutation",
      ),
      mutation(
        add,
        "ae-add-two",
        {
          kind: "activate",
          semanticEffect: "unknown",
          target: target("add second product", { role: "button", name: "Add to cart" }),
        },
        visible(target("added confirmation", { text: "Added!" })),
      ),
      mutation(add, "ae-continue-two", {
        kind: "activate",
        semanticEffect: "unknown",
        target: target("continue shopping", { role: "button", name: "Continue Shopping" }),
      }),
      intent(
        cart,
        "ae-cart",
        { kind: "navigate", url: "https://automationexercise.com/view_cart" },
        navigation("https://automationexercise.com/view_cart", "exact"),
      ),
      inspect(cart, "ae-cart-heading", target("shopping cart", { text: "Shopping Cart" })),
      inspect(cart, "ae-cart-blue-top", target("blue top cart row", { text: "Blue Top" })),
      inspect(cart, "ae-cart-tshirt", target("men tshirt cart row", { text: "Men Tshirt" })),
      mutation(cleanup, "ae-delete-one", {
        kind: "same_origin_request",
        method: "GET",
        authentication: "current_browser_session",
        path: "/delete_cart/1",
        expectedStatus: { min: 200, max: 399 },
      }),
      mutation(cleanup, "ae-delete-two", {
        kind: "same_origin_request",
        method: "GET",
        authentication: "current_browser_session",
        path: "/delete_cart/2",
        expectedStatus: { min: 200, max: 399 },
      }),
      intent(
        cleanup,
        "ae-empty-cart",
        { kind: "navigate", url: "https://automationexercise.com/view_cart" },
        navigation("https://automationexercise.com/view_cart", "exact"),
        "live_mutation",
      ),
      inspect(cleanup, "ae-empty-proof", target("cart empty", { text: "Cart is empty!" })),
      intent(
        tests,
        "ae-test-cases",
        {
          kind: "activate",
          semanticEffect: "unknown",
          target: target("test cases", { role: "link", name: "Test Cases" }),
        },
        navigation("https://automationexercise.com/test_cases", "path"),
      ),
      inspect(
        tests,
        "ae-test-cases-heading",
        target("test cases heading", { role: "heading", name: "Test Cases" }),
      ),
    ],
  ];
}

function demoBlazeIntents(ownership: M2Ownership): MissionAuthoringIntent[][] {
  const browse = owner(ownership, "browse");
  const add = owner(ownership, "cart_add");
  const cleanup = owner(ownership, "cleanup");
  const modals = owner(ownership, "modals");
  return [
    [
      intent(
        browse,
        "db-home",
        { kind: "navigate", url: "https://www.demoblaze.com/index.html" },
        navigation("https://www.demoblaze.com/index.html", "exact"),
      ),
      intent(browse, "db-phones", {
        kind: "activate",
        semanticEffect: "unknown",
        target: target("phones category", { role: "link", name: "Phones" }),
      }),
      inspect(
        browse,
        "db-phone-proof",
        target("phone product", { role: "link", name: "Samsung galaxy s6" }),
      ),
      intent(browse, "db-laptops", {
        kind: "activate",
        semanticEffect: "unknown",
        target: target("laptops category", { role: "link", name: "Laptops" }),
      }),
      inspect(
        browse,
        "db-laptop-proof",
        target("laptop product", { role: "link", name: "Sony vaio i5" }),
      ),
      intent(
        add,
        "db-product",
        { kind: "navigate", url: "https://www.demoblaze.com/prod.html?idp_=1" },
        navigation("https://www.demoblaze.com/prod.html?idp_=1", "exact"),
        "live_mutation",
      ),
      mutation(add, "db-add", {
        kind: "activate",
        semanticEffect: "unknown",
        target: target("add to cart", { role: "link", name: "Add to cart" }),
      }),
      intent(
        add,
        "db-cart",
        { kind: "navigate", url: "https://www.demoblaze.com/cart.html" },
        navigation("https://www.demoblaze.com/cart.html", "exact"),
      ),
      inspect(add, "db-cart-product", target("cart product", { text: "Samsung galaxy s6" })),
      mutation(
        cleanup,
        "db-delete",
        {
          kind: "activate",
          semanticEffect: "unknown",
          target: target("delete cart item", { role: "link", name: "Delete" }),
        },
        hidden(target("cart product", { text: "Samsung galaxy s6" })),
      ),
      intent(
        modals,
        "db-home-modals",
        { kind: "navigate", url: "https://www.demoblaze.com/index.html" },
        navigation("https://www.demoblaze.com/index.html", "exact"),
      ),
      intent(
        modals,
        "db-login-modal",
        {
          kind: "activate",
          semanticEffect: "unknown",
          target: target("login modal", { role: "link", name: "Log in" }),
        },
        visible(target("login dialog", { role: "dialog", name: "Log in" })),
      ),
      intent(
        modals,
        "db-close-login",
        { kind: "press", semanticEffect: "unknown", key: "Escape" },
        hidden(target("login dialog", { role: "dialog", name: "Log in" })),
      ),
      intent(
        modals,
        "db-contact-modal",
        {
          kind: "activate",
          semanticEffect: "unknown",
          target: target("contact modal", { role: "link", name: "Contact" }),
        },
        visible(target("contact dialog", { role: "dialog", name: "New message" })),
      ),
      intent(
        modals,
        "db-close-contact",
        { kind: "press", semanticEffect: "unknown", key: "Escape" },
        hidden(target("contact dialog", { role: "dialog", name: "New message" })),
      ),
    ],
  ];
}

function xyzBankIntents(ownership: M2Ownership): MissionAuthoringIntent[][] {
  const customer = owner(ownership, "customer");
  const transactions = owner(ownership, "transactions");
  const logout = owner(ownership, "logout");
  const manager = owner(ownership, "manager");
  const origin = "https://www.globalsqa.com/angularJs-protractor/BankingProject/#";
  return [
    [
      intent(
        customer,
        "xyz-login-page",
        { kind: "navigate", url: `${origin}/login` },
        navigation(`${origin}/login`, "exact"),
      ),
      intent(
        customer,
        "xyz-customer-login",
        {
          kind: "activate",
          semanticEffect: "unknown",
          target: target("customer login", { role: "button", name: "Customer Login" }),
        },
        visible(target("customer selector", { role: "combobox", name: "Your Name" })),
      ),
      intent(customer, "xyz-select-customer", {
        kind: "select",
        target: target("customer selector", { role: "combobox", name: "Your Name" }),
        value: "2",
      }),
      intent(
        customer,
        "xyz-login",
        {
          kind: "activate",
          semanticEffect: "unknown",
          target: target("login", { role: "button", name: "Login" }),
        },
        visible(target("logout", { role: "button", name: "Logout" })),
      ),
      inspect(customer, "xyz-account-number", target("account number", { text: "Account Number" })),
      intent(
        transactions,
        "xyz-transactions",
        {
          kind: "activate",
          semanticEffect: "unknown",
          target: target("transactions", { role: "button", name: "Transactions" }),
        },
        visible(target("back", { role: "button", name: "Back" })),
      ),
      inspect(
        transactions,
        "xyz-transaction-table",
        target("transaction table", { text: "Date-Time" }),
      ),
      intent(
        transactions,
        "xyz-back",
        {
          kind: "activate",
          semanticEffect: "unknown",
          target: target("back", { role: "button", name: "Back" }),
        },
        visible(target("logout", { role: "button", name: "Logout" })),
      ),
      intent(
        logout,
        "xyz-logout",
        {
          kind: "activate",
          semanticEffect: "unknown",
          target: target("logout", { role: "button", name: "Logout" }),
        },
        visible(target("customer selector", { role: "combobox", name: "Your Name" })),
      ),
      intent(
        manager,
        "xyz-login-page-again",
        { kind: "navigate", url: `${origin}/login` },
        navigation(`${origin}/login`, "exact"),
      ),
      intent(
        manager,
        "xyz-manager",
        {
          kind: "activate",
          semanticEffect: "unknown",
          target: target("bank manager login", { role: "button", name: "Bank Manager Login" }),
        },
        visible(target("customers", { role: "button", name: "Customers" })),
      ),
      intent(
        manager,
        "xyz-customers",
        {
          kind: "activate",
          semanticEffect: "unknown",
          target: target("customers", { role: "button", name: "Customers" }),
        },
        visible(target("first name column", { text: "First Name" })),
      ),
      inspect(manager, "xyz-customer-proof", target("known customer", { text: "Hermoine" })),
    ],
  ];
}

function contactListIntents(
  ownership: M2Ownership,
  credentialIds: Record<string, string>,
  prefix: string,
): MissionAuthoringIntent[][] {
  if (!credentialIds.email || !credentialIds.password)
    throw new Error("M2_CONTACT_CREDENTIALS_REQUIRED");
  const user = owner(ownership, "user");
  const create = owner(ownership, "create_contact");
  const read = owner(ownership, "read_contact");
  const update = owner(ownership, "update_contact");
  const deleteContact = owner(ownership, "delete_contact");
  const deleteUser = owner(ownership, "delete_user");
  return [
    [
      intent(
        user,
        "cl-add-user",
        { kind: "navigate", url: "https://thinking-tester-contact-list.herokuapp.com/addUser" },
        navigation("https://thinking-tester-contact-list.herokuapp.com/addUser", "exact"),
        "live_mutation",
      ),
      publicFill(
        user,
        "cl-first-name",
        target("first name", { role: "textbox", label: "First Name" }),
        "Scry",
      ),
      publicFill(
        user,
        "cl-last-name",
        target("last name", { role: "textbox", label: "Last Name" }),
        prefix.slice(0, 20),
      ),
      protectedFill(
        user,
        "cl-email",
        target("email", { role: "textbox", label: "Email" }),
        credentialIds.email,
        "live_mutation",
      ),
      protectedFill(
        user,
        "cl-password",
        target("password", { role: "textbox", label: "Password" }),
        credentialIds.password,
        "live_mutation",
      ),
      mutation(
        user,
        "cl-submit-user",
        {
          kind: "activate",
          semanticEffect: "unknown",
          target: target("submit user", { role: "button", name: "Submit" }),
        },
        navigation("https://thinking-tester-contact-list.herokuapp.com/contactList", "path"),
      ),
      mutation(
        create,
        "cl-add-contact",
        {
          kind: "activate",
          semanticEffect: "unknown",
          target: target("add new contact", { role: "button", name: "Add a New Contact" }),
        },
        navigation("https://thinking-tester-contact-list.herokuapp.com/addContact", "path"),
      ),
      publicFill(
        create,
        "cl-contact-first",
        target("contact first name", { role: "textbox", label: "First Name" }),
        "Campaign",
      ),
      publicFill(
        create,
        "cl-contact-last",
        target("contact last name", { role: "textbox", label: "Last Name" }),
        prefix.slice(0, 20),
      ),
      publicFill(
        create,
        "cl-contact-email",
        target("contact email", { role: "textbox", label: "Email" }),
        `${prefix}@example.test`,
      ),
      publicFill(
        create,
        "cl-contact-phone",
        target("contact phone", { role: "textbox", label: "Phone" }),
        "8005550100",
      ),
      mutation(
        create,
        "cl-submit-contact",
        {
          kind: "activate",
          semanticEffect: "unknown",
          target: target("submit contact", { role: "button", name: "Submit" }),
        },
        navigation("https://thinking-tester-contact-list.herokuapp.com/contactList", "path"),
      ),
      intent(
        read,
        "cl-open-contact",
        {
          kind: "activate",
          semanticEffect: "unknown",
          target: target("campaign contact", { text: prefix.slice(0, 20), exact: false }),
        },
        navigation("https://thinking-tester-contact-list.herokuapp.com/contactDetails", "contains"),
        "ordinary",
        true,
      ),
      inspect(
        read,
        "cl-read-contact",
        target("campaign contact email", { text: `${prefix}@example.test` }),
      ),
      mutation(
        update,
        "cl-edit-contact",
        {
          kind: "activate",
          semanticEffect: "unknown",
          target: target("edit contact", { role: "button", name: "Edit Contact" }),
        },
        navigation("https://thinking-tester-contact-list.herokuapp.com/editContact", "contains"),
      ),
      publicFill(
        update,
        "cl-update-phone",
        target("contact phone", { role: "textbox", label: "Phone" }),
        "8005550199",
      ),
      mutation(update, "cl-submit-update", {
        kind: "activate",
        semanticEffect: "unknown",
        target: target("submit contact update", { role: "button", name: "Submit" }),
      }),
      inspect(update, "cl-update-proof", target("updated phone", { text: "8005550199" })),
    ],
    [
      mutation(
        deleteContact,
        "cl-delete-contact",
        {
          kind: "activate",
          semanticEffect: "unknown",
          target: target("delete contact", { role: "button", name: "Delete Contact" }),
        },
        navigation("https://thinking-tester-contact-list.herokuapp.com/contactList", "path"),
      ),
      mutation(deleteUser, "cl-delete-user", {
        kind: "same_origin_request",
        method: "DELETE",
        authentication: "current_browser_session",
        path: "/users/me",
        expectedStatus: { min: 200, max: 204 },
      }),
    ],
  ];
}

type Owner = M2Ownership["flows"][string];

function flow(
  key: string,
  objective: string,
  flowName: string,
  purpose: M2FlowDefinition["purpose"],
  authorizeMutation = false,
): M2FlowDefinition {
  return {
    key,
    objective,
    flow: flowName,
    purpose,
    ...(authorizeMutation ? { authorizeMutation } : {}),
  };
}

function owner(ownership: M2Ownership, key: string): Owner {
  const value = ownership.flows[key];
  if (!value) throw new Error(`M2_FLOW_OWNER_MISSING_${key.toUpperCase()}`);
  return value;
}

function target(
  concept: string,
  evidence: Omit<MissionAuthoringSemanticTarget, "concept" | "exact"> & { exact?: boolean },
): MissionAuthoringSemanticTarget {
  return { concept, exact: evidence.exact ?? true, ...evidence };
}

function intent(
  ownerValue: Owner,
  intentId: string,
  action: MissionAuthoringIntent["action"],
  expectedEffect: MissionAuthoringIntent["expectedEffect"] = { kind: "none" },
  authorizationKind: MissionAuthoringIntent["authorization"]["kind"] = "ordinary",
  allowNonExact = false,
  allowNewPage = false,
): MissionAuthoringIntent {
  return missionAuthoringIntentSchema.parse({
    intentId,
    objectiveId: ownerValue.objectiveId,
    flowDraftId: ownerValue.flowDraftId,
    action,
    expectedEffect,
    constraints: { timeoutMs: 60_000, allowNewPage, allowNonExact },
    authorization: {
      kind: authorizationKind,
      ...(authorizationKind === "live_mutation"
        ? { authorizationId: ownerValue.authorizationId }
        : {}),
    },
    protectedInputReferences:
      action.kind === "fill" && action.protectedReferenceId ? [action.protectedReferenceId] : [],
  });
}

function mutation(
  ownerValue: Owner,
  intentId: string,
  action: MissionAuthoringIntent["action"],
  expectedEffect: MissionAuthoringIntent["expectedEffect"] = { kind: "none" },
) {
  return intent(ownerValue, intentId, action, expectedEffect, "live_mutation");
}

function protectedFill(
  ownerValue: Owner,
  intentId: string,
  semanticTarget: MissionAuthoringSemanticTarget,
  reference: string,
  authorizationKind: "authentication" | "live_mutation" = "authentication",
) {
  return intent(
    ownerValue,
    intentId,
    { kind: "fill", target: semanticTarget, protectedReferenceId: reference },
    { kind: "none" },
    authorizationKind,
  );
}

function publicFill(
  ownerValue: Owner,
  intentId: string,
  semanticTarget: MissionAuthoringSemanticTarget,
  value: string,
) {
  return intent(ownerValue, intentId, { kind: "fill", target: semanticTarget, publicValue: value });
}

function inspect(
  ownerValue: Owner,
  intentId: string,
  semanticTarget: MissionAuthoringSemanticTarget,
) {
  return intent(ownerValue, intentId, { kind: "inspect", target: semanticTarget });
}

function navigation(url: string, match: "exact" | "path" | "contains") {
  return { kind: "navigation" as const, url, match };
}

function visible(semanticTarget: MissionAuthoringSemanticTarget) {
  return { kind: "target_visibility" as const, target: semanticTarget, visible: true };
}

function hidden(semanticTarget: MissionAuthoringSemanticTarget) {
  return { kind: "target_visibility" as const, target: semanticTarget, visible: false };
}

function state(
  semanticTarget: MissionAuthoringSemanticTarget,
  value: { checked?: boolean; enabled?: boolean },
) {
  return { kind: "target_state" as const, target: semanticTarget, ...value };
}
