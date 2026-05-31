# @absolutejs/blob changelog

## 0.1.0 — 2026-05-31

Initial release. Closes G11 from the second-pass PaaS audit — the
substrate now has object storage as a first-class primitive.

### Added

- **`BlobStore` interface** — `put / get / getStream / head / delete /
  list / presign`. The same shape across every adapter so swapping
  providers is one constructor change.
- **`BlobError`** with codes (`NOT_FOUND`, `ALREADY_EXISTS`,
  `UNAUTHORIZED`, `INVALID_KEY`, `UNSUPPORTED`, `PROVIDER_ERROR`).
- **`validateKey(key)`** — closes the path-traversal class of bugs
  at the substrate. Rejects leading `/`, NUL bytes, and `.` / `..`
  segments. Adapters call it on every operation.
- **`collectBody(body)`** — coerces `Uint8Array | string |
  ReadableStream<Uint8Array>` into bytes. Shared by adapters that
  need to materialize a stream (e.g. to compute ETag).

### Adapters — `@absolutejs/blob/local`

- **`localBlobStore({ root, mode? })`** — filesystem-backed store.
  Files at `<root>/<key>`; metadata (contentType, user metadata,
  cache headers) at `<root>/<key>.meta.json`. Atomic writes via
  temp file + rename. `mkdir -p` the root on first write.
- **List** walks the directory recursively, skips `.meta.json`
  companions + temp files, sorts keys alphabetically, paginates via
  cursor.
- **`getStream`** returns a `ReadableStream<Uint8Array>` via Node's
  `Readable.toWeb()`.
- **`presign`** throws `BlobError('UNSUPPORTED')` — the filesystem
  has no equivalent.

### Adapters — `@absolutejs/blob/s3`

- **`s3BlobStore({ client, bucket })`** — S3-compatible store. Works
  against AWS S3, Cloudflare R2, Backblaze B2, MinIO, Wasabi,
  Tigris — anything that speaks SigV4 against the S3 HTTP API.
- **Narrow `S3ClientLike` interface** with seven methods
  (`putObject`, `getObject`, `headObject`, `deleteObject`,
  `listObjectsV2`, `presignPutObject`, `presignGetObject`). Wire
  `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` in ~20
  lines (template in the README). No hard SDK dep.
- **Not-found detection** is structural — `error.name === 'NoSuchKey'`,
  `'NotFound'`, `error.$metadata?.httpStatusCode === 404`, or the
  underlying client returning `null`. `get` / `head` map to `null`;
  `delete` is idempotent.
- **`presign`** routes to `presignGetObject` (default) or
  `presignPutObject` (`operation: 'put'`). `ttlSeconds` default
  3600. `contentType` on put-presign for upload validation.

### Tests

34 covering: key validation (5 paths), body collection (3 input
types), `BlobError` shape, local round-trip + metadata + streams +
delete idempotency + sorted/prefixed/paginated list + skip meta-
companion + atomic-write + nested-key mkdir + presign-throws-
UNSUPPORTED. S3 mock client (put + contentType+metadata+cacheControl
forwarding, get/head null on missing, get null on NoSuchKey or
$metadata 404, head ETag-quote-stripping, delete idempotent on
NotFound, list pagination, presign get + put + default operation).

### Build

Three bundle entries (`index`, `local`, `s3`), `--root src` layout.

### License

BSL-1.1 with named carveout against hosted object-storage services
(S3, R2, B2, Wasabi, GCS, Azure Blob, Vercel Blob, Supabase Storage,
DigitalOcean Spaces, Linode Object Storage). Change date:
2030-05-31 (Apache 2.0).
