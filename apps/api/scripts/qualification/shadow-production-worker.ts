import { configureShadowBrowserNetwork } from "./shadow-vitract-network.js";
const proxy = process.env.SCRY_SHADOW_PROXY_URL;
if (!proxy) throw new Error("SHADOW_PROXY_REQUIRED");
configureShadowBrowserNetwork(proxy);
await import("../../src/worker.js");
