import { expect, it } from "vitest";
import { createNativeAdapterProtector } from "../src/native-adapter-protection.js";
const secret = "fictional-private-bound-secret";
const policy = createNativeAdapterProtector({ selected: secret });
const response = (body: string, type = "application/json") =>
  policy.cleanApi({ execution: "completed", status: 200, contentType: type, body }) as any;
it("keeps API receipt protection independent of an unfinished DOM read while retaining every known secret", () => {
  const p = createNativeAdapterProtector({ key: secret });
  p.beginNativeRead();
  const raw = {
    execution: "completed",
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      authorized: true,
      token: "fictional-unclassified-token",
      message: secret,
    }),
  };
  const safe = p.cleanApi(raw) as typeof raw;
  expect(JSON.parse(safe.body)).toMatchObject({
    authorized: true,
    token: "[PROTECTED:API_RESPONSE]",
  });
  expect(JSON.stringify(safe)).not.toContain(secret);
  expect(safe.status).toBe(200);
  expect(p.clean("ordinary DOM metadata")).toBe("[UNAVAILABLE:NATIVE_PROTECTION_TEXT]");
  p.dispose();
});
it("continues withholding API strings if the shared secret history reaches capacity", () => {
  const p = createNativeAdapterProtector({ key: secret });
  p.capacityExceeded();
  expect(
    JSON.stringify(
      p.cleanApi({
        body: JSON.stringify({ message: secret }),
        contentType: "application/json",
        status: 200,
      }),
    ),
  ).not.toContain(secret);
  expect((p.cleanApi({ body: secret }) as { body: string }).body).toContain("UNAVAILABLE");
  p.dispose();
});
it.each([
  "password",
  "access_token",
  "refreshToken",
  "api_key",
  "authorization",
  "cookie",
  "session",
  "credentials",
  "cardNumber",
  "pan",
  "verification_secret",
])("redacts sensitive JSON field %s", (key) => {
  const r = response(
    JSON.stringify({ ok: true, nested: { [key]: "unclassified-sensitive-value" } }),
  );
  expect(r.body).not.toContain("unclassified-sensitive-value");
  expect(JSON.parse(r.body).ok).toBe(true);
});
it.each([secret, encodeURIComponent(secret), Buffer.from(secret).toString("base64")])(
  "redacts a selected value and its encodings",
  (value) => {
    expect(response(JSON.stringify({ message: value })).body).not.toContain(value);
  },
);
it("recognizes numeric card data and contextual receipt codes without changing ordinary status values", () => {
  const body = JSON.parse(
    response(JSON.stringify({ number: 4111111111111111, code: "123456", statusCode: 409, id: 123 }))
      .body,
  );
  expect(body.number).toContain("PROTECTED");
  expect(body.code).toContain("PROTECTED");
  expect(body.statusCode).toBe(409);
  expect(body.id).toBe(123);
});
it("invalid JSON never falls back to an unprotected raw body", () => {
  const r = response('{"access_token":"unclassified-sensitive-value",}');
  expect(r.bodyIssue).toBe("invalid_json");
  expect(r.body).not.toContain("unclassified-sensitive-value");
});
it("text containing malformed JSON-style secret assignments is still protected", () => {
  const r = response('prefix "password": "unclassified-sensitive-value", broken', "text/plain");
  expect(r.body).not.toContain("unclassified-sensitive-value");
});
it("does not silently truncate array data when structural limits are reached", () => {
  const r = response(JSON.stringify(Array.from({ length: 1001 }, (_, i) => ({ id: i }))));
  expect(r.bodyIssue).toBe("response_structure_capacity");
  expect(() => JSON.parse(r.body)).toThrow();
});
it("deep JSON is omitted with a specific structural limitation", () => {
  let body: any = { ok: true };
  for (let i = 0; i < 30; i++) body = { nested: body };
  expect(response(JSON.stringify(body)).bodyIssue).toBe("response_structure_capacity");
});
