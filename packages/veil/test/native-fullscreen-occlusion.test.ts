import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";

function fixture() {
  const document = { fullscreenElement: null as any };
  const style = {
    overlay: "none",
    backgroundColor: "rgb(255, 255, 255)",
    opacity: "1",
    backgroundClip: "border-box",
    borderRadius: "0px",
    backgroundImage: "none",
    backgroundBlendMode: "normal",
    mixBlendMode: "normal",
    filter: "none",
    backdropFilter: "none",
    clipPath: "none",
    maskImage: "none",
    transform: "none",
    perspective: "none",
    animationName: "none",
    transitionProperty: "all",
    transitionDuration: "0s",
  };
  const make = (parentElement: any = null): any => ({
    nodeType: 1,
    parentElement,
    ownerDocument: document,
    namespaceURI: "http://www.w3.org/1999/xhtml",
    style: { ...style },
    getRootNode: () => document,
    matches: () => false,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 1280, bottom: 720 }),
  });
  const root = make(),
    fullscreen = make(root),
    owner = make(fullscreen),
    other = make(root);
  fullscreen.matches = (selector: string) => selector === ":fullscreen";
  fullscreen.style.overlay = "auto";
  document.fullscreenElement = fullscreen;
  const occludes = runInNewContext(
    readFileSync(new URL("../src/native-mask-runtime.js", import.meta.url), "utf8") +
      "\nnativeFullscreenOccludesPublicPaint",
    { document, getComputedStyle: (node: any) => node.style },
  );
  const box = { left: 20, top: 30, right: 220, bottom: 60 };
  return {
    document,
    fullscreen,
    owner,
    other,
    root,
    make,
    box,
    check: () => occludes(owner, other, box),
  };
}

it("ignores only ordinary public paint behind an opaque fullscreen surface", () => {
  const f = fixture();
  expect(f.check()).toBe(true);
  f.document.fullscreenElement = null;
  expect(f.check()).toBe(false);
});
it("keeps public paint in the same fullscreen surface as a real collision", () => {
  const f = fixture();
  f.other.parentElement = f.fullscreen;
  expect(f.check()).toBe(false);
});
it("requires the private owner to belong to that fullscreen surface", () => {
  const f = fixture();
  f.owner.parentElement = f.root;
  expect(f.check()).toBe(false);
});
it.each(["auto", "unsupported", undefined])(
  "retains higher and pending top-layer public paint: %s",
  (overlay) => {
    const f = fixture(),
      popover = f.make(f.root);
    popover.style.overlay = overlay;
    f.other.parentElement = popover;
    // No pseudo-class match is needed: a closing top-layer element can still paint.
    expect(f.check()).toBe(false);
  },
);
it("walks assigned slots and open shadow hosts when checking native top-layer ancestors", () => {
  const f = fixture(),
    host = f.make(f.root),
    slot = f.make(host);
  host.style.overlay = "auto";
  f.other.assignedSlot = slot;
  expect(f.check()).toBe(false);
  f.other.assignedSlot = null;
  f.other.parentElement = null;
  f.other.getRootNode = () => ({ host });
  expect(f.check()).toBe(false);
});
it.each([
  ["backgroundColor", "rgba(255, 255, 255, 0.5)"],
  ["backgroundColor", "transparent"],
  ["opacity", "0.5"],
  ["backgroundClip", "content-box"],
  ["borderRadius", "8px"],
  ["backgroundImage", "linear-gradient(red, blue)"],
  ["backgroundBlendMode", "multiply"],
  ["mixBlendMode", "multiply"],
  ["filter", "blur(1px)"],
  ["backdropFilter", "blur(1px)"],
  ["clipPath", "circle(50%)"],
  ["maskImage", "linear-gradient(black, transparent)"],
  ["transform", "matrix(1, 0, 0, 1, 1, 0)"],
  ["perspective", "1px"],
  ["animationName", "fade"],
  ["transitionDuration", "0s, 1s"],
  ["overlay", "none"],
])("does not assume opaque coverage for %s=%s", (key, value) => {
  const f = fixture();
  (f.fullscreen.style as any)[key] = value;
  expect(f.check()).toBe(false);
});
it("requires the entire guarded mask to fit inside the opaque surface", () => {
  const f = fixture();
  f.box.left = -1;
  expect(f.check()).toBe(false);
  f.box.left = 20;
  f.box.bottom = 721;
  expect(f.check()).toBe(false);
  f.box.bottom = NaN;
  expect(f.check()).toBe(false);
});
it("rejects shadow-retargeted, foreign-document and unconfirmed fullscreen facts", () => {
  const f = fixture();
  f.fullscreen.getRootNode = () => ({ host: f.root });
  expect(f.check()).toBe(false);
  f.fullscreen.getRootNode = () => f.document;
  f.fullscreen.ownerDocument = {};
  expect(f.check()).toBe(false);
  f.fullscreen.ownerDocument = f.document;
  f.fullscreen.matches = () => false;
  expect(f.check()).toBe(false);
});
it("fails closed for cyclic ownership or unavailable style facts", () => {
  const f = fixture();
  f.owner.parentElement = f.owner;
  expect(f.check()).toBe(false);
  f.owner.parentElement = f.fullscreen;
  f.other.parentElement = f.other;
  expect(f.check()).toBe(false);
  f.other.parentElement = f.root;
  f.fullscreen.style = null;
  expect(f.check()).toBe(false);
});
