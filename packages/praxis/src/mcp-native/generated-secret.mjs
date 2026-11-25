import { observeControlState } from "./known-controls.mjs";
/** Fixed private read, not a generic DOM evaluation or an issuance operation. */
export async function captureGeneratedSecret({
  input,
  request,
  interactions,
  protection,
  allowedOrigins,
}) {
  let guard, handle;
  try {
    const page = await interactions.activePage();
    if (
      !allowedOrigins.includes(input.sourceOrigin) ||
      new URL(page.url()).origin !== input.sourceOrigin
    )
      return { reason: "source_origin_changed" };
    guard = await observeControlState(page);
    const locator =
      "ref" in input.target
        ? page.locator("aria-ref=" + input.target.ref)
        : page.locator("css=" + input.target.selector);
    if ((await locator.count()) !== 1) return { reason: "source_not_unique" };
    handle = await locator.elementHandle({ timeout: 1000 });
    if (!handle || !(await guard.valid())) return { reason: "source_changed" };
    const frame = await handle.ownerFrame();
    if (!frame || new URL(frame.url()).origin !== input.sourceOrigin)
      return { reason: "source_origin_changed" };
    const readValue = (e, origin) => {
      if (!e.isConnected || new URL(e.ownerDocument.URL).origin !== origin || e.isContentEditable)
        return null;
      if (!e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return null;
      if (e.localName === "input" || e.localName === "textarea")
        return e.readOnly === true ? e.value : null;
      if (
        !["code", "pre", "samp", "output"].includes(e.localName) &&
        e.getAttribute("role") !== "code"
      )
        return null;
      const clone = e.cloneNode(true);
      // An adjacent Copy control is not part of the generated value. No live
      // DOM mutation, clipboard read or click is performed.
      for (const node of clone.querySelectorAll(
        "button,a,input,textarea,select,[role=button],script,style",
      ))
        node.remove();
      return clone.textContent;
    };
    const sourceValue = await handle.evaluate(readValue, input.sourceOrigin);
    let value = sourceValue;
    if (typeof value !== "string") return { reason: "source_not_a_readonly_secret_view" };
    if (input.trimWhitespace) value = value.trim();
    if (!value || Buffer.byteLength(value) > 8192) return { reason: "source_value_unavailable" };
    if (!(await guard.valid()) || new URL(page.url()).origin !== input.sourceOrigin)
      return { reason: "source_changed" };
    if ((await handle.evaluate(readValue, input.sourceOrigin)) !== sourceValue)
      return { reason: "source_changed" };
    return { sealedSecret: protection.sealGeneratedSecret(value, request) };
  } catch {
    return { reason: "protected_capture_unavailable" };
  } finally {
    await handle?.dispose().catch(() => {});
    await guard?.dispose().catch(() => {});
  }
}
