import type { Page } from "playwright";

import { resolveSemanticPageContextControl } from "../page-context.js";
import { PraxisStaleTargetError } from "../observation.js";
import { fillPinnedElement } from "./fill.js";

export type PraxisProtectedAuthenticationInput = Readonly<{
  fields: ReadonlyArray<Readonly<{ targetReference: string; resolveValue: () => Promise<string> }>>;
  submitReference: string;
}>;

/** Exact, same-document authentication mechanics; callers own Veil composition. */
export async function authenticateProtectedReferencedTargets(
  page: Page,
  input: PraxisProtectedAuthenticationInput,
  beforeDispatch?: () => void | Promise<void>,
) {
  if (input.fields.length < 1) throw new Error("PRAXIS_PROTECTED_AUTH_FIELDS_REQUIRED");
  const fields = input.fields.map(({ targetReference, resolveValue }) => {
    const control = resolveSemanticPageContextControl(page, targetReference);
    if (!control || !control.capabilities.includes("enter_text")) throw new PraxisStaleTargetError();
    return { control, resolveValue };
  });
  const submit = resolveSemanticPageContextControl(page, input.submitReference);
  if (!submit || !submit.capabilities.includes("activate")) throw new PraxisStaleTargetError();

  for (const { control } of fields) await control.handle.assertCurrent();
  await submit.handle.assertCurrent();
  const resolved = await Promise.all(fields.map(async ({ control, resolveValue }) => ({
    control,
    value: await resolveValue(),
  })));
  try {
    await beforeDispatch?.();
    for (const { control, value } of resolved) {
      await fillPinnedElement(control.element as import("playwright").ElementHandle<HTMLElement>, value);
      await control.handle.assertCurrent();
    }
    await submit.handle.assertCurrent();
    await (submit.element as import("playwright").ElementHandle<HTMLElement>).click({ noWaitAfter: true });
    return { dispatched: true as const };
  } finally {
    for (const field of resolved) field.value = "";
  }
}
