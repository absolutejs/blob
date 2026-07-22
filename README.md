# @absolutejs/blob

Object storage substrate for AbsoluteJS. One `BlobStore` interface, multiple
adapters, and bounded streaming for large artifacts.

```ts
const store: BlobStore = /* localBlobStore(...) | s3BlobStore(...) */;
await store.put('users/42/avatar.png', body, { contentType: 'image/png' });
const bytes = await store.get('users/42/avatar.png');
const url = await store.presign('users/42/avatar.png', { ttlSeconds: 900 });
```

## Adapters

| Subpath                        | Backs                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------ |
| `@absolutejs/blob/local`       | Filesystem (dev / single-host prod / tests)                                                      |
| `@absolutejs/blob/s3`          | AWS S3, Cloudflare R2, Backblaze B2, MinIO, Wasabi, Tigris — any S3-compatible HTTP API          |
| `@absolutejs/blob/aws-s3`      | Official AWS SDK wiring, including multipart streaming uploads                                   |
| `@absolutejs/blob/uploadthing` | UploadThing server SDK with stable application-owned custom ids and signed reads                 |
| `@absolutejs/blob/inspection`  | Provider-neutral inspection contract, bounded stored-object inspection, and ClamAV clamd adapter |

Both implement the same `BlobStore` interface — swap providers with
one constructor change.

## Private upload inspection

Uploads that can contain customer-controlled bytes should remain under a
private quarantine key until an inspector returns `clean`. The inspection
subpath preserves the same workflow across local, UploadThing, S3, R2, and
Spaces storage:

```ts
import {
  createClamdBlobInspector,
  inspectStoredBlob,
} from "@absolutejs/blob/inspection";

const inspector = createClamdBlobInspector({ host: "clamav.internal" });
const result = await inspectStoredBlob(blobs, inspector, {
  filename: "evidence.pdf",
  key: "quarantine/case/evidence.pdf",
  maxBytes: 25 * 1024 * 1024,
});
```

The clamd adapter uses the bounded `INSTREAM` protocol and returns `clean`,
`infected`, or `unavailable`. Scanner errors never become a clean verdict. The
host owns durable quarantine, retry, retention, and audit policy; Blob only
owns byte transport and normalized inspection.

## Local

```ts
import { localBlobStore } from "@absolutejs/blob/local";

const blobs = localBlobStore({ root: "./var/blobs" });
await blobs.put("uploads/file.pdf", body);
```

Files at `<root>/<key>`. Metadata (contentType, user metadata,
cache headers) at `<root>/<key>.meta.json`. Atomic writes via temp
file + rename. `presign()` throws `BlobError('UNSUPPORTED')` —
use the S3 adapter against a local MinIO if you need presign in
dev.

## S3 (any S3-compatible service)

```ts
import { S3Client } from "@aws-sdk/client-s3";
import { awsS3BlobStore } from "@absolutejs/blob/aws-s3";

const aws = new S3Client({ region: "us-east-1" });

const blobs = awsS3BlobStore({ bucket: "my-bucket", client: aws });
```

`awsS3BlobStore` uses the official SDK command clients and
`@aws-sdk/lib-storage` multipart uploads. Streams are never materialized as one
control-plane buffer. The lower-level `s3BlobStore` and `S3ClientLike` remain
available for custom clients.

### Cloudflare R2

```ts
const aws = new S3Client({
  region: "auto",
  endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId, secretAccessKey },
});
```

R2 is fully S3-compatible — the only thing that changes is the
`endpoint`. Same wiring + `s3BlobStore` adapter.

### Backblaze B2, MinIO, Wasabi, Tigris

All the same pattern. Point `endpoint` at the provider's URL,
provide credentials, hand the client into `s3BlobStore`.

## BlobStore interface

```ts
type BlobStore = {
  readonly description: string;
  put: (
    key: string,
    body: BlobBody,
    options?: PutOptions,
  ) => Promise<BlobObject>;
  get: (key: string) => Promise<Uint8Array | null>;
  getStream: (key: string) => Promise<ReadableStream<Uint8Array> | null>;
  head: (key: string) => Promise<BlobObject | null>;
  delete: (key: string) => Promise<void>;
  list: (options?: ListOptions) => Promise<ListResult>;
  presign: (key: string, options?: PresignOptions) => Promise<string>;
};

type BlobBody = Uint8Array | string | ReadableStream<Uint8Array>;
```

- `put` returns the stored object's metadata (size, contentType,
  etag, user metadata).
- `get` returns `null` for missing keys (not throw).
- `getStream` for large blobs — avoids loading the body into memory.
- `delete` is idempotent: deleting a missing key is success.
- `list` paginates via `cursor` — pass back into the next call as
  `options.cursor`.
- `presign` builds a time-limited URL for direct browser upload/
  download. `operation: 'put'` for uploads, `'get'` (default) for
  downloads. Throws `BlobError('UNSUPPORTED')` on `local`.

## Key validation

```ts
validateKey("users/42/avatar.png"); // ok
validateKey("/etc/passwd"); // BlobError('INVALID_KEY')
validateKey("../escape"); // BlobError('INVALID_KEY')
validateKey("with\0nul"); // BlobError('INVALID_KEY')
```

Adapters call `validateKey()` on every operation. Leading slashes,
NUL bytes, and `.` / `..` path segments throw `BlobError('INVALID_KEY')`
— closes the path-traversal class of bugs at the substrate level.

## License

BSL-1.1 with named carveout against hosted object-storage services.
Change date: 2030-05-31 (Apache 2.0).
