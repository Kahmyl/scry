import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";

// Operator-only helper. Never invoked by application startup or image builds.
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--out" || !isAbsolute(args[1])) {
  console.error(
    "Usage: node scripts/operations/generate-oauth-keys.mjs --out /absolute/private/path.env",
  );
  process.exit(1);
}
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const signingKey = {
  ...privateKey.export({ format: "jwk" }),
  kid: randomUUID(),
  alg: "RS256",
  use: "sig",
};
const content = [
  `SCRY_OAUTH_COOKIE_KEYS_JSON='${JSON.stringify([randomBytes(48).toString("base64url")])}'`,
  `SCRY_OAUTH_JWKS_JSON='${JSON.stringify({ keys: [signingKey] })}'`,
  "",
].join("\n");
try {
  writeFileSync(args[1], content, { flag: "wx", mode: 0o600 });
} catch {
  console.error(
    "Could not create private key file. Choose a new path; existing keys are never overwritten.",
  );
  process.exit(1);
}
console.log(
  "Created a private OAuth key file. Transfer it through your secret manager; never commit or paste its contents.",
);
