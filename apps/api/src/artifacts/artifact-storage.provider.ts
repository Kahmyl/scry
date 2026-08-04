import { createArtifactStoreFromEnv, type ArtifactStore } from "@scry/artifact";

export const ARTIFACT_STORE = Symbol("ARTIFACT_STORE");

export const artifactStoreProvider = {
  provide: ARTIFACT_STORE,
  useFactory(): ArtifactStore {
    return createArtifactStoreFromEnv(process.env, requireAdmissionKey()).store;
  },
};

function requireAdmissionKey() {
  const key = process.env.VEIL_ADMISSION_KEY;
  if (!key) throw new Error("VEIL_ADMISSION_KEY_REQUIRED");
  return key;
}
