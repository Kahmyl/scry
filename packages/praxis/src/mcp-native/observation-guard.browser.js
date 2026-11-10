(el) => {
  const attrs = [
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
  ];
  const references = () =>
    ["aria-labelledby", "aria-describedby"].flatMap((a) =>
      (el.getAttribute(a) ?? "")
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => el.ownerDocument.getElementById(id))
        .filter(Boolean),
    );
  const related = references();
  const fingerprint = () =>
    JSON.stringify({
      tag: el.tagName,
      attrs: attrs.map((a) => [a, el.getAttribute(a)]),
      labels: [...(el.labels ?? [])].map((x) => x.textContent),
      references: references().map((x) => [x.id, x.textContent]),
      text: ["BUTTON", "A"].includes(el.tagName) ? el.textContent : undefined,
      form: el.form
        ? { id: el.form.id, action: el.form.action, method: el.form.method, target: el.form.target }
        : null,
      options: el.options
        ? [...el.options].map((o) => ({ value: o.value, label: o.label, disabled: o.disabled }))
        : undefined,
    });
  const baseline = fingerprint();
  let invalid = false,
    blocked = false;
  const relevant = (r) => {
    if (
      r.type === "attributes" &&
      (r.target === el || r.target === el.form) &&
      attrs.includes(r.attributeName)
    )
      return true;
    if (r.type === "childList" && [...r.removedNodes].some((n) => n === el || n.contains?.(el)))
      return true;
    if (el.contains(r.target) && ["BUTTON", "SELECT", "A"].includes(el.tagName)) return true;
    return [...(el.labels ?? []), ...related].some((l) => l === r.target || l.contains(r.target));
  };
  const record = (rs) => {
    if (rs.some(relevant) || !el.isConnected || fingerprint() !== baseline) invalid = true;
  };
  const observer = new MutationObserver(record);
  observer.observe(el.ownerDocument, {
    subtree: true,
    attributes: true,
    attributeOldValue: true,
    childList: true,
    characterData: true,
  });
  // Also observe open shadow trees containing the control; a document observer does not cross them.
  const root = el.getRootNode();
  if (root !== el.ownerDocument)
    observer.observe(root, {
      subtree: true,
      attributes: true,
      attributeOldValue: true,
      childList: true,
      characterData: true,
    });
  const check = () => {
    record(observer.takeRecords());
    return !invalid;
  };
  const barrier = (e) => {
    if (!check()) {
      blocked = true;
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  };
  for (const name of ["beforeinput", "keydown", "pointerdown", "mousedown", "click", "change"])
    el.addEventListener(name, barrier, { capture: true });
  return {
    check,
    wasBlocked: () => blocked,
    dispose: () => {
      observer.disconnect();
      for (const n of ["beforeinput", "keydown", "pointerdown", "mousedown", "click", "change"])
        el.removeEventListener(n, barrier, { capture: true });
    },
  };
};
