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
  const ids = new Set(
    [...document.querySelectorAll("[aria-labelledby],[aria-describedby]")].flatMap((e) =>
      ["aria-labelledby", "aria-describedby"].flatMap((a) =>
        (e.getAttribute(a) ?? "").split(/\s+/).filter(Boolean),
      ),
    ),
  );
  let invalid = false;
  const referenced = (e) => {
    for (; e; e = e.parentElement) if (ids.has(e.id)) return true;
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
        (n) => n.nodeType === 1 && (n.matches(controls) || n.querySelector(controls)),
      );
    return false;
  };
  const record = (rs) => {
    if (rs.some(significant)) invalid = true;
  };
  const observer = new MutationObserver(record);
  const watch = (root) => {
    observer.observe(root, {
      subtree: true,
      attributes: true,
      childList: true,
      characterData: true,
    });
    for (const e of root.querySelectorAll("*")) if (e.shadowRoot) watch(e.shadowRoot);
  };
  watch(document);
  return {
    check: () => {
      record(observer.takeRecords());
      return !invalid;
    },
    dispose: () => observer.disconnect(),
  };
};
