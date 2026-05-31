# @absolutejs/blob

Object storage substrate for the AbsoluteJS PaaS. One `BlobStore`
interface, multiple adapters, no hard SDK dependency.

```ts
const store: BlobStore = /* localBlobStore(...) | s3BlobStore(...) */;
await store.put('users/42/avatar.png', body, { contentType: 'image/png' });
const bytes = await store.get('users/42/avatar.png');
const url = await store.presign('users/42/avatar.png', { ttlSeconds: 900 });
```

## Adapters

| Subpath | Backs |
| --- | --- |
| `@absolutejs/blob/local` | Filesystem (dev / single-host prod / tests) |
| `@absolutejs/blob/s3` | AWS S3, Cloudflare R2, Backblaze B2, MinIO, Wasabi, Tigris — any S3-compatible HTTP API |

Both implement the same `BlobStore` interface — swap providers with
one constructor change.

## Local

```ts
import { localBlobStore } from '@absolutejs/blob/local';

const blobs = localBlobStore({ root: './var/blobs' });
await blobs.put('uploads/file.pdf', body);
```

Files at `<root>/<key>`. Metadata (contentType, user metadata,
cache headers) at `<root>/<key>.meta.json`. Atomic writes via temp
file + rename. `presign()` throws `BlobError('UNSUPPORTED')` —
use the S3 adapter against a local MinIO if you need presign in
dev.

## S3 (any S3-compatible service)

```ts
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { s3BlobStore, type S3ClientLike } from '@absolutejs/blob/s3';

const aws = new S3Client({ region: 'us-east-1' });

const client: S3ClientLike = {
  putObject:      (i) => aws.send(new PutObjectCommand(i as never)) as never,
  getObject:      (i) => aws.send(new GetObjectCommand(i as never)) as never,
  headObject:     (i) => aws.send(new HeadObjectCommand(i as never)) as never,
  deleteObject:   (i) => aws.send(new DeleteObjectCommand(i as never)) as never,
  listObjectsV2:  (i) => aws.send(new ListObjectsV2Command(i as never)) as never,
  presignGetObject: (i, o) => getSignedUrl(aws as never, new GetObjectCommand(i as never), o),
  presignPutObject: (i, o) => getSignedUrl(aws as never, new PutObjectCommand(i as never), o),
};

const blobs = s3BlobStore({ client, bucket: 'my-bucket' });
```

### Cloudflare R2

```ts
const aws = new S3Client({
  region: 'auto',
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
  put: (key: string, body: BlobBody, options?: PutOptions) => Promise<BlobObject>;
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
validateKey('users/42/avatar.png');  // ok
validateKey('/etc/passwd');          // BlobError('INVALID_KEY')
validateKey('../escape');            // BlobError('INVALID_KEY')
validateKey('with\0nul');            // BlobError('INVALID_KEY')
```

Adapters call `validateKey()` on every operation. Leading slashes,
NUL bytes, and `.` / `..` path segments throw `BlobError('INVALID_KEY')`
— closes the path-traversal class of bugs at the substrate level.

## License

BSL-1.1 with named carveout against hosted object-storage services.
Change date: 2030-05-31 (Apache 2.0).
