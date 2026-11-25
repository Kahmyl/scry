() => {
  const attrs = new Set([
    "id",
    "name",
    "type",
    "role",
    "aria-label",
    "aria-labelledby",
    "aria-describedby",
    "form",
    "formaction",
    "formmethod",
    "formtarget",
    "action",
    "method",
    "href",
    "target",
    "download",
    "disabled",
    "readonly",
    "required",
    "multiple",
  ]);
  const controls =
    "input,textarea,button,select,option,a,label,form,[role=button],[role=link],[role=checkbox],[role=radio],[role=textbox],[role=combobox],[contenteditable=true]";
  const ids = new Map(),
    roots = new Set();
  let invalid = false;
  // A bounded journal allows a completed input to prove that React's temporary
  // name rewrite restored the original submission identity. Never reset a guard
  // after an unclassified mutation, overflow, or a change to another control.
  let mutations = [],
    overflow = false;
  const referenced = (e) => {
    const references = ids.get(e?.getRootNode());
    for (; e; e = e.parentElement) if (references?.has(e.id)) return true;
    return false;
  };
  const significant = (r) => {
    if (r.type === "attributes") return attrs.has(r.attributeName);
    const e = r.target.nodeType === 1 ? r.target : r.target.parentElement;
    if (
      e?.closest("button,select,option,a,label,[role=button],[role=link],[contenteditable=true]") ||
      referenced(e)
    )
      return true;
    if (r.type === "childList")
      return [...r.addedNodes, ...r.removedNodes].some(
        (n) =>
          n.nodeType === 1 &&
          (n.matches(controls) ||
            n.querySelector(controls) ||
            n.shadowRoot ||
            [...n.querySelectorAll("*")].some((e) => e.shadowRoot)),
      );
    return false;
  };
  const record = (rs) => {
    for (const r of rs)
      if (significant(r)) {
        invalid = true;
        if (mutations.length < 256) mutations.push(r);
        else overflow = true;
      }
  };
  const observer = new MutationObserver(record);
  const watch = (root) => {
    roots.add(root);
    ids.set(
      root,
      new Set(
        [...root.querySelectorAll("[aria-labelledby],[aria-describedby]")].flatMap((e) =>
          ["aria-labelledby", "aria-describedby"].flatMap((a) =>
            (e.getAttribute(a) ?? "").split(/\s+/).filter(Boolean),
          ),
        ),
      ),
    );
    observer.observe(root, {
      subtree: true,
      attributes: true,
      attributeOldValue: true,
      childList: true,
      characterData: true,
    });
    for (const e of root.querySelectorAll("*")) if (e.shadowRoot) watch(e.shadowRoot);
  };
  watch(document);
  // attachShadow on an existing host emits no document mutation. Compare root
  // inventory rather than silently admitting controls in an unobserved tree.
  const visitRoots = (root) => {
    for (const e of root.querySelectorAll("*"))
      if (e.shadowRoot) {
        if (!roots.has(e.shadowRoot) || !visitRoots(e.shadowRoot)) {
          invalid = true;
          return false;
        }
      }
    return true;
  };
  const sameRoots = () => {
    for (const known of roots)
      if (known.host && !known.host.isConnected) {
        invalid = true;
        return false;
      }
    return visitRoots(document);
  };
  return {
    check: () => {
      record(observer.takeRecords());
      return !invalid && sameRoots();
    },
    advanceAfterInput: (input) => {
      record(observer.takeRecords());
      if (!sameRoots()) return false;
      if (overflow || !input?.isConnected || !["INPUT", "TEXTAREA"].includes(input.tagName))
        return false;
      if (
        mutations.some(
          (r) =>
            r.type !== "attributes" ||
            r.target !== input ||
            (r.attributeName !== "name" && r.oldValue !== input.getAttribute(r.attributeName)),
        )
      )
        return false;
      const name = mutations.find((r) => r.attributeName === "name");
      if (name && input.getAttribute("name") !== name.oldValue) return false;
      mutations = [];
      invalid = false;
      return true;
    },
    dispose: () => observer.disconnect(),
  };
};
