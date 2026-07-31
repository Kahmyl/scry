import type { Locator, Page } from "playwright";
import type { PlanLocator } from "@scry/contracts";

export function resolveLocator(page: Page, locator: PlanLocator): Locator {
  switch (locator.strategy) {
    case "role":
      return page.getByRole(locator.role, {
        ...(locator.name ? { name: locator.name } : {}),
        exact: locator.exact,
      });
    case "label":
      return page.getByLabel(locator.value, { exact: locator.exact });
    case "placeholder":
      return page.getByPlaceholder(locator.value, { exact: locator.exact });
    case "text":
      return page.getByText(locator.value, { exact: locator.exact });
    case "testId":
      return page.getByTestId(locator.value);
    case "css":
      return page.locator(locator.value);
  }
}

export async function resolveUniqueLocator(page: Page, locator: PlanLocator): Promise<Locator> {
  const resolved = resolveLocator(page, locator);
  const count = await resolved.count();
  if (count > 1) {
    throw new AmbiguousTargetError(locator, count);
  }
  return resolved;
}

export class AmbiguousTargetError extends Error {
  constructor(locator: PlanLocator, count: number) {
    super(
      `Target is ambiguous: ${describeLocator(locator)} matched ${count} elements. `
      + "Use a role, accessible name, test ID, scoped CSS selector, or exact text that identifies one element.",
    );
    this.name = "AmbiguousTargetError";
  }
}

function describeLocator(locator: PlanLocator) {
  if (locator.strategy === "role") {
    return `role ${JSON.stringify(locator.role)}${locator.name ? ` named ${JSON.stringify(locator.name)}` : ""}`;
  }
  if (locator.strategy === "testId") return `test ID ${JSON.stringify(locator.value)}`;
  return `${locator.strategy} ${JSON.stringify(locator.value)}`;
}
