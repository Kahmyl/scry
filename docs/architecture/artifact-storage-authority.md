# Artifact storage authority

Scry selects one artifact storage provider at process startup through `ARTIFACT_STORAGE_PROVIDER`. The API reader and worker writer use the same `@scry/artifact` factory and therefore cannot silently disagree about the storage boundary. Missing credentials or invalid provider configuration fail startup before storage I/O.

## Supported modes

| Mode         | Intended backend                              | Required configuration                                                   |
| ------------ | --------------------------------------------- | ------------------------------------------------------------------------ |
| `local`      | Local development and single-host deployments | `ARTIFACT_ROOT`                                                          |
| `s3`         | AWS S3 or an S3-compatible service            | bucket, region, access key, secret key; endpoint for compatible services |
| `cloudinary` | Cloudinary authenticated raw assets           | cloud name, API key, API secret                                          |
| `gcs`        | Google Cloud Storage                          | bucket, project, and a service-account JSON value or credentials file    |

The `s3` mode is deliberately generic. For a free/open-source deployment, use self-hosted RustFS or self-hosted Supabase Storage and configure its S3 endpoint. This avoids a separate provider-specific implementation while retaining one tested object-storage protocol.

## Privacy and integrity invariants

- Veil admission is verified before bytes are persisted.
- Retrieval verifies the signed admission proof; complete reads also hash the returned bytes.
- Remote range reads require signed admission plus matching immutable checksum metadata before releasing a byte range.
- Storage keys are relative and traversal-safe.
- Remote uploads remove their local staging copy after admission.
- Quarantine and retention destroy bytes through the selected provider and verify disappearance.
- Cloudinary objects use authenticated `raw` delivery, not public image delivery.

Provider credentials are infrastructure secrets and must never be placed in source control. Use `ARTIFACT_STORAGE_PREFIX` to isolate an environment or tenant inside a bucket/account.
