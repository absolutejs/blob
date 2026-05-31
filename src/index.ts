/**
 * @absolutejs/blob — object storage substrate.
 *
 * One `BlobStore` interface, multiple adapters:
 *
 *   - `@absolutejs/blob/local` — filesystem (dev / single-host prod)
 *   - `@absolutejs/blob/s3` — S3-compatible (AWS S3, Cloudflare R2,
 *     Backblaze B2, MinIO, Wasabi)
 *
 * Adapters share the same shape so swapping providers is one
 * constructor change.
 *
 * Out-of-scope (deliberate):
 *   - Multipart-upload streams above ~100 MB. Use the underlying
 *     SDK directly if you need them; this primitive is for the
 *     "one file at a time" 95% case.
 *   - CDN integration. The presign URLs from S3-compat stores work
 *     for direct browser download; CDN cache invalidation is the
 *     CDN's job.
 *   - Encryption-at-rest beyond what the underlying service does.
 *     SSE-S3 / customer keys / etc. ride through the adapter
 *     options when supported.
 */

// =============================================================================
// Shape
// =============================================================================

/** Metadata that travels with every blob. */
export type BlobMetadata = {
	/** Size in bytes. */
	size: number;
	/** MIME type the blob was stored with (or `undefined` if unset). */
	contentType?: string;
	/** Server-side ETag (typically the MD5 hash, but provider-specific). */
	etag?: string;
	/** Last-modified time, ms since epoch. */
	lastModified?: number;
	/** Caller-supplied user metadata. */
	metadata?: Record<string, string>;
};

/** A blob plus its key — what `list()` and `head()` return. */
export type BlobObject = BlobMetadata & {
	key: string;
};

export type PutOptions = {
	/** Override MIME type. Adapters may detect from extension if omitted. */
	contentType?: string;
	/** User metadata stored alongside the blob. */
	metadata?: Record<string, string>;
	/** `Cache-Control` header for HTTP-served blobs. */
	cacheControl?: string;
	/** `Content-Disposition` (e.g. `'attachment; filename="x.pdf"'`). */
	contentDisposition?: string;
};

export type ListOptions = {
	/** Only return keys starting with this prefix. */
	prefix?: string;
	/** Continuation token from a previous truncated list. */
	cursor?: string;
	/** Max keys per page. Adapter-dependent default; typically 1000. */
	limit?: number;
};

export type ListResult = {
	objects: BlobObject[];
	/** Pass back as `options.cursor` to continue paging. */
	cursor?: string;
	/** `true` when there are more pages. */
	truncated: boolean;
};

export type PresignOperation = 'get' | 'put';

export type PresignOptions = {
	/** Operation. `'get'` for downloads, `'put'` for direct browser uploads. Default `'get'`. */
	operation?: PresignOperation;
	/** URL validity in seconds. Default 3600 (1 hour). */
	ttlSeconds?: number;
	/** For `'put'`: optional Content-Type the uploader must use. */
	contentType?: string;
};

/**
 * The shared interface every adapter implements. Keep the
 * concrete adapter behind this type at call sites so swapping
 * `localBlobStore` for `s3BlobStore` is one constructor change.
 */
export type BlobStore = {
	/** Human-readable identifier for logs. */
	readonly description: string;
	/** Upload. Returns the stored object's metadata. */
	put: (
		key: string,
		body: BlobBody,
		options?: PutOptions
	) => Promise<BlobObject>;
	/** Download bytes. `null` when the key doesn't exist. */
	get: (key: string) => Promise<Uint8Array | null>;
	/**
	 * Stream download — preferred for large blobs. `null` when the
	 * key doesn't exist.
	 */
	getStream: (key: string) => Promise<ReadableStream<Uint8Array> | null>;
	/** Metadata only, no body. `null` when the key doesn't exist. */
	head: (key: string) => Promise<BlobObject | null>;
	/**
	 * Delete a key. 404 is idempotent success — matches the rest of
	 * the substrate's delete contracts.
	 */
	delete: (key: string) => Promise<void>;
	/** Paginated list. */
	list: (options?: ListOptions) => Promise<ListResult>;
	/**
	 * Build a time-limited URL the browser can `GET` (download) or
	 * `PUT` (upload) directly without proxying bytes through your
	 * server. Some adapters (`local`) don't support this and throw.
	 */
	presign: (key: string, options?: PresignOptions) => Promise<string>;
};

/** What `put()` accepts as the body. */
export type BlobBody = Uint8Array | string | ReadableStream<Uint8Array>;

// =============================================================================
// Error class
// =============================================================================

export class BlobError extends Error {
	readonly code:
		| 'NOT_FOUND'
		| 'ALREADY_EXISTS'
		| 'UNAUTHORIZED'
		| 'INVALID_KEY'
		| 'UNSUPPORTED'
		| 'PROVIDER_ERROR';
	readonly cause?: unknown;
	constructor(
		message: string,
		code: BlobError['code'],
		options: { cause?: unknown } = {}
	) {
		super(message);
		this.name = 'BlobError';
		this.code = code;
		if (options.cause !== undefined) this.cause = options.cause;
	}
}

// =============================================================================
// Helpers used by adapters
// =============================================================================

/** Bytes from a string / Uint8Array / stream into a single Uint8Array. */
export const collectBody = async (body: BlobBody): Promise<Uint8Array> => {
	if (typeof body === 'string') return new TextEncoder().encode(body);
	if (body instanceof Uint8Array) return body;
	// Stream
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value !== undefined) {
			chunks.push(value);
			total += value.length;
		}
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
};

/** Validate that a key doesn't contain path-traversal or absolute prefixes. */
export const validateKey = (key: string): void => {
	if (key.length === 0) {
		throw new BlobError('blob key cannot be empty', 'INVALID_KEY');
	}
	if (key.startsWith('/')) {
		throw new BlobError(
			`blob key cannot start with '/' (got "${key}")`,
			'INVALID_KEY'
		);
	}
	if (key.includes('\0')) {
		throw new BlobError('blob key cannot contain NUL bytes', 'INVALID_KEY');
	}
	// Path traversal: ".." as a segment.
	for (const segment of key.split('/')) {
		if (segment === '..' || segment === '.') {
			throw new BlobError(
				`blob key cannot contain "." or ".." segments (got "${key}")`,
				'INVALID_KEY'
			);
		}
	}
};
