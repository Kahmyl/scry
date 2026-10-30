import { rm } from "node:fs/promises";
import type { VeilBrowserProtectionPort, VeilBrowserSessionPort } from "@scry/contracts";
import { ProtectionAuthority } from "./protection-authority.js";
import { ProtectedCaptureVault } from "./protected-capture-vault.js";
import { BrowserProtectedKeyring } from "./protected-keyring.js";
import { EvidenceCipher } from "./evidence-cipher.js";
import { createRecordingProtection } from "./recording-admission.js";
import { recordingProtectionOptions } from "./recording-protection.js";
import { safeDomSemanticHint } from "./transport-protection.js";

/** Supplies policy capabilities without exposing key material to browser execution. */
export class VeilBrowserProtection implements VeilBrowserProtectionPort {
  readEvidence(scope: Parameters<VeilBrowserProtectionPort["readEvidence"]>[0]) {
    const context = `${scope.runId}:${scope.sessionId}`,
      keyId = scope.protectionKeyId;
    let cipher: EvidenceCipher | undefined;
    return {
      decryptCompressed(aad: Buffer, nonce: Buffer, ciphertext: Buffer, tag: Buffer): Buffer {
        if (!cipher) {
          const keyring = BrowserProtectedKeyring.fromEnvironment();
          cipher = new EvidenceCipher(keyring.derive(keyId, "evidence", context), [
            keyring.deriveLegacy(keyId, "evidence", context),
          ]);
        }
        return cipher.decryptCompressed(aad, nonce, ciphertext, tag);
      },
    };
  }
  createSession(
    input: Parameters<VeilBrowserProtectionPort["createSession"]>[0],
  ): VeilBrowserSessionPort {
    const { scope } = input;
    const keyring = BrowserProtectedKeyring.fromEnvironment();
    const context = `${scope.runId}:${scope.sessionId}`;
    const authority = new ProtectionAuthority({
      scope: {
        projectId: scope.projectId,
        missionId: scope.missionId,
        runId: scope.runId,
        sessionId: scope.sessionId,
        origin: new URL(scope.baseOrigin).origin,
      },
      disclosureMode: scope.disclosureMode,
      protectedValues: input.protectedValues,
      restoredPublicValues: input.restoredPublicValues,
    });
    const vault = new ProtectedCaptureVault({
      directory: input.captureDirectory,
      runId: scope.runId,
      scopeId: scope.sessionId,
      authority,
      encryptionKey: keyring.derive(scope.protectionKeyId, "capture", context),
      legacyEncryptionKeys: [keyring.deriveLegacy(scope.protectionKeyId, "capture", context)],
    });
    return {
      authority,
      vault,
      evidenceProtection: new EvidenceCipher(
        keyring.derive(scope.protectionKeyId, "evidence", context),
        [keyring.deriveLegacy(scope.protectionKeyId, "evidence", context)],
      ),
      recordingProtection: createRecordingProtection({ authority }),
      privacyOptions: recordingProtectionOptions,
      semanticHint: (value) => safeDomSemanticHint(value, authority),
      async restoreCaptures(captures) {
        // PostgreSQL, not files left by a dead worker, is authoritative.
        await rm(input.captureDirectory, { recursive: true, force: true });
        await vault.initialize();
        for (const capture of captures) await vault.restoreDurableCapture(capture);
        await vault.resumeUnsettledProtection();
      },
    };
  }
}
