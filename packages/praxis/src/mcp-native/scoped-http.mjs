import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { scopedRequestSchema } from "@scry/contracts";

const restricted = new BlockList(),
  never = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
])
  restricted.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["169.254.0.0", 16],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
])
  never.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["::", 128],
  ["ff00::", 8],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
])
  never.addSubnet(address, prefix, "ipv6");
never.addAddress("100.100.100.200", "ipv4");
never.addAddress("168.63.129.16", "ipv4");
never.addAddress("fd00:ec2::254", "ipv6");
restricted.addSubnet("2001::", 23, "ipv6");
restricted.addSubnet("2001:db8::", 32, "ipv6");
restricted.addSubnet("2002::", 16, "ipv6");
const global6 = new BlockList();
global6.addSubnet("2000::", 3, "ipv6");
export function allowedAddress(address, allowPrivate = false) {
  const family = isIP(address);
  if (!family) return false;
  const type = family === 4 ? "ipv4" : "ipv6";
  if (never.check(address, type)) return false;
  if (allowPrivate) return true;
  return !restricted.check(address, type) && (family === 4 || global6.check(address, "ipv6"));
}
const safeFailure = (execution, reason, extra = {}) => ({ execution, reason, ...extra });
/** No ambient cookies/proxy credentials, redirects, retries, DNS rebinding or
 * socket reuse. Authorization values exist only inside this private worker. */
export async function scopedHttp(
  input,
  {
    allowedOrigins,
    privateOrigins = [],
    resolve = (host) => lookup(host, { all: true, verbatim: true }),
  },
  bindings = [],
) {
  const parsed = scopedRequestSchema.safeParse(input);
  if (!parsed.success) return safeFailure("not_dispatched", "invalid_request");
  input = parsed.data;
  const expected = [...input.credentials, ...input.bodyBindings];
  if (
    expected.length !== bindings.length ||
    expected.some(
      (e, i) =>
        Object.entries(e).some(
          ([k, v]) => JSON.stringify(v) !== JSON.stringify(bindings[i]?.[k]),
        ) || typeof bindings[i]?.value !== "string",
    )
  )
    return safeFailure("not_dispatched", "credential_binding_unavailable");
  const started = Date.now(),
    deadline = started + input.timeoutMs;
  let url;
  try {
    url = new URL(input.url);
  } catch {
    return safeFailure("not_dispatched", "invalid_url");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    !allowedOrigins.includes(url.origin)
  )
    return safeFailure("not_dispatched", "origin_denied");
  if (
    [...url.searchParams.keys()].some((k) =>
      /(?:password|secret|token|api[-_]?key|authorization|cookie|code)/i.test(k),
    )
  )
    return safeFailure("not_dispatched", "url_secret_reference_required");
  if (bindings.length && url.protocol !== "https:" && !privateOrigins.includes(url.origin))
    return safeFailure("not_dispatched", "credential_transport_denied");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let timer;
  const controller = new AbortController();
  timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const addresses = await Promise.race([
      isIP(host) ? Promise.resolve([{ address: host, family: isIP(host) }]) : resolve(host),
      new Promise((_, reject) =>
        controller.signal.addEventListener("abort", () => reject(Error("deadline")), {
          once: true,
        }),
      ),
    ]);
    if (
      !Array.isArray(addresses) ||
      !addresses.length ||
      addresses.length > 16 ||
      addresses.some((a) => !allowedAddress(a.address, privateOrigins.includes(url.origin)))
    )
      return safeFailure("not_dispatched", "network_destination_denied");
    if (controller.signal.aborted || Date.now() >= deadline)
      return safeFailure("not_dispatched", "deadline_before_dispatch");
    const headers = {
      accept: "application/json",
      "accept-encoding": "identity",
      ...Object.fromEntries(Object.entries(input.headers).map(([k, v]) => [k.toLowerCase(), v])),
      host: url.host,
    };
    const secretVariants = [];
    for (const binding of bindings.filter((b) => b.header)) {
      if (
        typeof binding.value !== "string" ||
        /[\r\n\0]/.test(binding.value) ||
        binding.value.length > 16000
      )
        return safeFailure("not_dispatched", "credential_unusable");
      const value =
        binding.format === "bearer"
          ? "Bearer " + binding.value
          : binding.format === "basic"
            ? "Basic " + Buffer.from(binding.value).toString("base64")
            : binding.value;
      headers[binding.header.toLowerCase()] = value;
      secretVariants.push(value, binding.value);
    }
    const body = structuredClone(input.body ?? {});
    for (const binding of bindings.filter((b) => b.path)) {
      let target = body;
      for (const key of binding.path.slice(0, -1)) {
        if (
          Object.hasOwn(target, key) &&
          (!target[key] || typeof target[key] !== "object" || Array.isArray(target[key]))
        )
          return safeFailure("not_dispatched", "body_binding_conflict");
        target = target[key] ??= Object.create(null);
      }
      const key = binding.path.at(-1);
      if (Object.hasOwn(target, key)) return safeFailure("not_dispatched", "body_binding_conflict");
      target[key] = binding.value;
      secretVariants.push(binding.value);
    }
    const payload = input.body || input.bodyBindings.length ? JSON.stringify(body) : undefined;
    if (payload && Buffer.byteLength(payload) > 32768)
      return safeFailure("not_dispatched", "body_capacity");
    if (payload) {
      headers["content-type"] ??= "application/json";
      headers["content-length"] = String(Buffer.byteLength(payload));
    }
    if (Buffer.byteLength(JSON.stringify(headers)) > 65536)
      return safeFailure("not_dispatched", "header_capacity");
    const address = addresses[0];
    return await new Promise((resolveResult) => {
      let completed = false,
        dispatched = false,
        status,
        bytes = 0;
      const chunks = [];
      const finish = (value) => {
        if (completed) return;
        completed = true;
        resolveResult({ ...value, elapsedMs: Date.now() - started, secretVariants });
      };
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
        {
          protocol: url.protocol,
          hostname: address.address,
          port: url.port || undefined,
          servername: host,
          family: isIP(address.address),
          method: input.method,
          path: url.pathname + url.search,
          headers,
          agent: false,
          signal: controller.signal,
          maxHeaderSize: 16384,
        },
        (response) => {
          status = response.statusCode;
          if (status >= 300 && status < 400) {
            response.destroy();
            finish(
              safeFailure("completed", "redirect_not_followed", { status, bodyOmitted: true }),
            );
            return;
          }
          const type = String(response.headers["content-type"] ?? "").slice(0, 200);
          const encoding = response.headers["content-encoding"];
          if (encoding && encoding !== "identity") {
            response.destroy();
            finish(safeFailure("unknown", "unsupported_encoding", { status, bodyOmitted: true }));
            return;
          }
          response.on("data", (chunk) => {
            bytes += chunk.length;
            if (bytes > input.maxResponseBytes) {
              response.destroy();
              finish(safeFailure("unknown", "response_capacity", { status, bodyOmitted: true }));
            } else chunks.push(chunk);
          });
          response.once("error", () =>
            finish(safeFailure("unknown", "response_interrupted", { status, bodyOmitted: true })),
          );
          response.once("end", () =>
            finish({
              execution: "completed",
              status,
              bytes,
              contentType: type,
              ...(/^(?:application\/(?:[\w.+-]*\+)?json|text\/plain)(?:;|$)/i.test(type)
                ? { body: Buffer.concat(chunks).toString("utf8") }
                : { bodyOmitted: true }),
              reason: "response_received",
            }),
          );
        },
      );
      request.once("socket", (socket) =>
        socket.once(url.protocol === "https:" ? "secureConnect" : "connect", () => {
          dispatched = true;
        }),
      );
      request.once("error", () =>
        finish(
          safeFailure(
            dispatched ? "unknown" : "not_dispatched",
            controller.signal.aborted ? "request_deadline" : "transport_failed",
            { ...(status ? { status } : {}), bodyOmitted: true },
          ),
        ),
      );
      request.end(payload);
    });
  } catch {
    return safeFailure("not_dispatched", "resolution_unavailable");
  } finally {
    clearTimeout(timer);
  }
}
