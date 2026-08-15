# Chronicle Legacy Compatibility

The implementation under `src/legacy/artifact-storage` was inherited from the
pre-rearchitecture `@scry/artifact` package.

## Retained temporarily

- local filesystem storage;
- S3-compatible backend;
- GCS backend;
- Cloudinary backend;
- remote backend mechanics;
- checksum metadata;
- range reads;
- deletion and destruction;
- quarantine;
- provider configuration.

## Not accepted as Chronicle architecture

- `VeilEvidenceAdmissionProof` as a storage parameter;
- admission HMAC signing in the storage subsystem;
- requiring Veil admission for reads;
- Veil-specific error semantics inside persistence;
- storage constructors requiring a Veil admission key.

These remain only because existing API and Executor consumers have not yet
been migrated.

## Migration rule

A legacy consumer should move to the clean Chronicle API only when its actual
trust boundary is understood.

Do not remove a Veil check merely to satisfy the new interface.

Instead:

1. establish which subsystem owns the trust decision;
2. enforce that decision there;
3. pass already-authorized bytes to Chronicle;
4. let Chronicle persist and verify storage integrity.
