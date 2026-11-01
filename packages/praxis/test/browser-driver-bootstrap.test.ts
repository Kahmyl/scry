import { expect, it, vi } from "vitest";

const f = vi.hoisted(() => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release, started: false, fork: vi.fn() };
});
vi.mock("node:child_process", () => ({ fork: f.fork }));
vi.mock("playwright", () => ({ chromium: {} }));
vi.mock("playwright-mcp-runtime", async () => {
  f.started = true;
  await f.gate;
  return { chromium: {} };
});

it("finishes cold driver initialization before supervised custody can be created", async () => {
  let loaded = false;
  const bootstrap = Promise.all([
    import("../src/supervised-browser.js"),
    import("../src/owned-browser.js"),
  ]).then(() => {
    loaded = true;
  });
  try {
    await vi.waitFor(() => expect(f.started || loaded).toBe(true));
    expect(f.started).toBe(true);
    expect(loaded).toBe(false);
    expect(f.fork).not.toHaveBeenCalled();
  } finally {
    f.release();
    await bootstrap;
  }
  expect(loaded).toBe(true);
});
