import { expect, it } from "vitest";
import { createNativeAdapterProtector } from "../src/native-adapter-protection.js";
const secret = "fictional-private-bound-secret";
const policy = createNativeAdapterProtector({ selected: secret });
const response = (body: string, type = "application/json") =>
  policy.cleanApi({ execution: "completed", status: 200, contentType: type, body }) as any;
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
