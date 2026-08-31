import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Invocation-local equality evidence, never value authority or persisted evidence. */
export function createProtectedInputVerification() {
  const key = randomBytes(32);
  const commitments = new Map<string, { digest: Buffer; length: number }>();
  let disposed = false;
  const digest = (value: string) => createHmac("sha256", key).update(value).digest();
  return {
    remember(reference: string, value: string) {
      if (disposed || commitments.has(reference))
        throw new Error("PROTECTED_INPUT_PRESENTATION_REPEATED");
      commitments.set(reference, { digest: digest(value), length: value.length });
    },
    matches(reference: string, actual: string, exact: boolean) {
      const expected = commitments.get(reference);
      if (disposed || !expected) return false;
      if (exact) return timingSafeEqual(expected.digest, digest(actual.trim()));
      for (let index = 0; index <= actual.length - expected.length; index++)
        if (timingSafeEqual(expected.digest, digest(actual.slice(index, index + expected.length))))
          return true;
      return false;
    },
    dispose() {
      disposed = true;
      for (const commitment of commitments.values())
        commitment.digest.set(new Uint8Array(commitment.digest.byteLength));
      commitments.clear();
      key.set(new Uint8Array(key.byteLength));
    },
  };
}
