// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { URL as NodeURL, fileURLToPath } from "node:url";
import path from "node:path";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BrandMark } from "../shared/components/BrandMark.js";

const publicDir = fileURLToPath(new NodeURL("../../public/", import.meta.url));
const read = (name: string) => readFileSync(path.join(publicDir, name));
const svg = (name: string) =>
  new DOMParser().parseFromString(read(name).toString(), "image/svg+xml");
afterEach(cleanup);

describe("Scry brand identity", () => {
  it("uses one decorative symbol without duplicating the adjacent accessible brand name", () => {
    const { container } = render(<BrandMark size={39} />);
    const image = container.querySelector("img")!;
    expect(image.getAttribute("src")).toBe("/brand/scry-symbol.svg");
    expect(image.getAttribute("alt")).toBe("");
    expect(image.getAttribute("aria-hidden")).toBe("true");
    expect(image.getAttribute("width")).toBe("39");
    expect(image.getAttribute("height")).toBe("39");
  });

  it("keeps identical symbol geometry across logo variants and favicon without remote resources", () => {
    const master = svg("brand/scry-symbol.svg");
    const masterPath = master.querySelector("path")!.getAttribute("d");
    expect(master.documentElement.getAttribute("viewBox")).toBe("24 24 208 208");
    for (const name of [
      "brand/scry-symbol.svg",
      "brand/scry-logo.svg",
      "brand/scry-logo-light.svg",
      "favicon.svg",
    ]) {
      const document = svg(name);
      expect(document.querySelector("parsererror")).toBeNull();
      expect(document.querySelector("path")!.getAttribute("d")).toBe(masterPath);
      expect(document.querySelector("rect")).toBeNull();
      expect(document.querySelector("g")!.getAttribute("fill")).toBe(
        name === "brand/scry-logo-light.svg" ? "#4D7C0F" : "#C7F36B",
      );
      expect(document.querySelector("use")!.getAttribute("href")).toBe("#scry-fold");
      expect(document.querySelector("script, foreignObject, image")).toBeNull();
      expect(read(name).toString()).not.toMatch(/https?:\/\/(?!www\.w3\.org\/2000\/svg)/);
    }
    expect(read("favicon.svg").equals(read("brand/scry-symbol.svg"))).toBe(true);
  });

  it("packages real 16, 32 and 48 pixel PNG frames inside the ICO", () => {
    const icon = read("favicon.ico");
    expect(icon.readUInt16LE(0)).toBe(0);
    expect(icon.readUInt16LE(2)).toBe(1);
    expect(icon.readUInt16LE(4)).toBe(3);
    for (const [index, size] of [16, 32, 48].entries()) {
      const entry = 6 + index * 16;
      expect(icon[entry]).toBe(size);
      expect(icon[entry + 1]).toBe(size);
      const length = icon.readUInt32LE(entry + 8);
      const offset = icon.readUInt32LE(entry + 12);
      const frame = icon.subarray(offset, offset + length);
      expect(frame.equals(read(`brand/favicon-${size}.png`))).toBe(true);
      expect(frame.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect(frame.readUInt32BE(16)).toBe(size);
      expect(frame.readUInt32BE(20)).toBe(size);
    }
  });

  it("provides correctly sized touch and install icons with real transparency", () => {
    const manifest = JSON.parse(read("site.webmanifest").toString());
    expect(manifest.name).toBe("Scry");
    expect(manifest.icons.map((icon: { sizes: string }) => icon.sizes)).toEqual([
      "192x192",
      "512x512",
    ]);
    for (const [name, size] of [
      ["apple-touch-icon.png", 180],
      ["brand/scry-icon-192.png", 192],
      ["brand/scry-icon-512.png", 512],
    ] as const) {
      const png = read(name);
      expect(png.readUInt32BE(16)).toBe(size);
      expect(png.readUInt32BE(20)).toBe(size);
      expect(png[25]).toBe(6); // PNG RGBA, not a flattened background.
    }
    for (const icon of manifest.icons)
      expect(read(icon.src.replace(/^\//, "")).length).toBeGreaterThan(100);
  });

  it("links real local assets from the document head", () => {
    const html = readFileSync(new NodeURL("../../index.html", import.meta.url), "utf8");
    const document = new DOMParser().parseFromString(html, "text/html");
    expect(
      document.querySelector('link[rel="icon"][type="image/svg+xml"]')!.getAttribute("href"),
    ).toBe("/favicon.svg");
    expect(document.querySelector('link[rel="apple-touch-icon"]')!.getAttribute("sizes")).toBe(
      "180x180",
    );
    for (const link of document.querySelectorAll(
      'link[rel="icon"], link[rel="apple-touch-icon"], link[rel="manifest"]',
    ))
      expect(read(link.getAttribute("href")!.slice(1)).length).toBeGreaterThan(0);
  });
});
