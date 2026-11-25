import React from "react";
import { createRoot } from "react-dom/client";
const h = React.createElement;
const mode = new URLSearchParams(location.search).get("mode");
function App() {
  const [value, set] = React.useState("-1");
  const valid = Number(value) >= 0;
  const outer = React.useRef(null),
    inner = React.useRef(null);
  React.useEffect(() => {
    new MutationObserver((rs) =>
      fetch("/trace", {
        method: "POST",
        body: JSON.stringify(
          rs.map((r) => ({
            kind: r.type,
            attr: r.attributeName,
            tag: r.target.nodeName,
            old: r.oldValue,
            html: r.target.outerHTML?.slice(0, 180),
            added: [...r.addedNodes].map((n) => n.nodeName),
            removed: [...r.removedNodes].map((n) => n.nodeName),
          })),
        ),
      }),
    ).observe(document, {
      subtree: true,
      attributes: true,
      attributeOldValue: true,
      childList: true,
      characterData: true,
    });
  }, []);
  React.useEffect(() => {
    if (mode === "nested-dialog") {
      outer.current.showModal();
      inner.current.showModal();
    }
  }, []);
  const price = h("input", {
    key: mode === "replace-input" ? String(valid) : "price",
    "aria-label": "Canada price",
    type: mode === "controlled-text" ? "text" : mode === "controlled-number" ? "number" : undefined,
    "aria-describedby":
      mode === "remove-describedby" ? (valid ? undefined : "price-error") : undefined,
    ...([
      "stable",
      "nested-dialog",
      "post-click-reply-lost",
      "unrelated-status",
      "native-change",
      "repeated-input",
      "worker-killed-after-effect",
    ].includes(mode)
      ? {
          defaultValue: "-1",
          onChange:
            mode === "unrelated-status"
              ? () => {
                  document.getElementById("unrelated-status").textContent = "Price updated";
                }
              : undefined,
        }
      : {
          value,
          onChange: (e) => {
            if (mode === "type-change-restored") {
              const x = e.target;
              x.type = "password";
              x.removeAttribute("type");
            }
            if (mode === "transient-button") {
              const b = document.querySelector("button");
              b.textContent = "Unexpected effect";
              b.textContent = "Select products";
            }
            if (mode === "submission-change")
              document
                .querySelector("button")
                .setAttribute("formaction", "https://unapproved.example");
            set(e.target.value);
          },
        }),
  });
  const error =
    mode === "controlled-no-validation"
      ? h("p", {}, "Unchanged helper")
      : mode === "referenced-error"
        ? h("p", { id: "price-error" }, valid ? "" : "Invalid price")
        : !valid
          ? h("p", { id: "price-error" }, "Invalid price")
          : null;
  const button = h(
    "button",
    {
      key: mode === "replace-button" ? String(valid) : "stage",
      type: "button",
      onClick: () => fetch("/effect", { method: "POST" }),
    },
    mode === "rename-button" && valid ? "Send invitation" : "Select products",
  );
  const content = h(
    "div",
    {},
    price,
    error,
    button,
    mode === "referenced-error" ? h("span", { "aria-describedby": "price-error" }, "Help") : null,
    mode === "unseen-control" && valid ? h("button", { type: "button" }, "New decision") : null,
    mode === "unrelated-status" ? h("p", { id: "unrelated-status" }, "Editing") : null,
  );
  return mode === "nested-dialog"
    ? h("dialog", { ref: outer }, h("h2", {}, "Outer"), h("dialog", { ref: inner }, content))
    : content;
}
if (
  [
    "stable",
    "nested-dialog",
    "post-click-reply-lost",
    "unrelated-status",
    "native-change",
    "repeated-input",
    "worker-killed-after-effect",
  ].includes(mode)
) {
  const content =
    '<input aria-label="Canada price" value="-1"><button type="button">Select products</button><p id="unrelated-status">Editing</p>';
  document.getElementById("root").innerHTML =
    mode === "nested-dialog"
      ? '<dialog id="outer"><dialog id="inner">' + content + "</dialog></dialog>"
      : content;
  document
    .querySelector("button")
    .addEventListener("click", () => fetch("/effect", { method: "POST" }));
  if (["native-change", "repeated-input", "worker-killed-after-effect"].includes(mode)) {
    const input = document.querySelector("input");
    input.addEventListener("input", () =>
      queueMicrotask(() => {
        input.name = "";
        input.removeAttribute("name");
      }),
    );
    input.addEventListener("change", () => fetch("/change", { method: "POST", body: input.value }));
  }
  if (mode === "unrelated-status")
    document
      .querySelector("input")
      .addEventListener(
        "input",
        () => (document.getElementById("unrelated-status").textContent = "Price updated"),
      );
  if (mode === "nested-dialog") {
    document.getElementById("outer").showModal();
    document.getElementById("inner").showModal();
  }
} else createRoot(document.getElementById("root")).render(h(App));
