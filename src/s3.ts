/**
 * @absolutejs/blob/s3 — S3-compatible adapter implementing
 * {@link BlobStore}.
 *
 * Works against any S3-compatible service:
 *
 *   - AWS S3
 *   - Cloudflare R2 (set the endpoint to your R2 account URL)
 *   - Backblaze B2 (S3-compatible API)
 *   - MinIO (self-hosted; great for local dev)
 *   - Wasabi, Tigris, etc.
 *
 * Narrow `S3ClientLike` interface keeps `@aws-sdk/client-s3` out as
 * a hard dep. Wire your own client with a ~30-line shim — see
 * README. Or use any HTTP client that speaks S3's SigV4.
 */

import {
	BlobError,
	collectBody,
	validateKey,
	type BlobBody,
	type BlobObject,
	type BlobStore,
	type ListOptions,
	type ListResult,
	type PresignOptions,
	type PutOptions
} from './index';

// =============================================================================
// Narrow S3 client interface — what we need from the underlying SDK
// =============================================================================

export type S3PutInput = {
	Bucket: string;
	Key: string;
	Body: Uint8Array | string | ReadableStream<Uint8Array>;
	ContentType?: string;
	Metadata?: Record<string, string>;
	CacheControl?: string;
	ContentDisposition?: string;
};

export type S3PutOutput = {
	ETag?: string;
};

export type S3GetInput = {
	Bucket: string;
	Key: string;
};

export type S3GetOutput = {
	Body?: ReadableStream<Uint8Array> | Uint8Array | string | null;
	ContentType?: string;
	ContentLength?: number;
	ETag?: string;
	LastModified?: Date;
	Metadata?: Record<string, string>;
};

export type S3HeadOutput = {
	ContentType?: string;
	ContentLength?: number;
	ETag?: string;
	LastModified?: Date;
	Metadata?: Record<string, string>;
};

export type S3ListInput = {
	Bucket: string;
	Prefix?: string;
	ContinuationToken?: string;
	MaxKeys?: number;
};

export type S3ListItem = {
	Key?: string;
	Size?: number;
	ETag?: string;
	LastModified?: Date;
};

export type S3ListOutput = {
	Contents?: S3ListItem[];
	NextContinuationToken?: string;
	IsTruncated?: boolean;
};

export type S3PresignInput = {
	Bucket: string;
	Key: string;
	ContentType?: string;
};

/**
 * Minimal client interface the adapter calls. Wire your
 * `@aws-sdk/client-s3` `S3Client` like this (see README for a
 * copy-paste template).
 */
export type S3ClientLike = {
	putObject: (input: S3PutInput) => Promise<S3PutOutput>;
	getObject: (input: S3GetInput) => Promise<S3GetOutput | null>;
	headObject: (input: S3GetInput) => Promise<S3HeadOutput | null>;
	deleteObject: (input: S3GetInput) => Promise<unknown>;
	listObjectsV2: (input: S3ListInput) => Promise<S3ListOutput>;
	presignPutObject: (
		input: S3PresignInput,
		options: { expiresIn: number }
	) => Promise<string>;
	presignGetObject: (
		input: S3PresignInput,
		options: { expiresIn: number }
	) => Promise<string>;
};

// =============================================================================
// Provider factory
// =============================================================================

export type S3BlobStoreOptions = {
	client: S3ClientLike;
	/** S3 bucket name (or R2 / B2 / MinIO equivalent). */
	bucket: string;
	/**
	 * Optional human-readable label for `description`. Defaults to
	 * `s3 bucket "<bucket>"`.
	 */
	label?: string;
};

/** Coerce a stringified body or stream into Uint8Array bytes. */
const bytesFromGetBody = async (
	body: S3GetOutput['Body']
): Promise<Uint8Array> => {
	if (body === undefined || body === null) return new Uint8Array(0);
	if (typeof body === 'string') return new TextEncoder().encode(body);
	if (body instanceof Uint8Array) return body;
	// ReadableStream
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

const streamFromGetBody = (
	body: S3GetOutput['Body']
): ReadableStream<Uint8Array> | null => {
	if (body === undefined || body === null) return null;
	if (body instanceof Uint8Array) {
		return new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(body);
				controller.close();
			}
		});
	}
	if (typeof body === 'string') {
		const bytes = new TextEncoder().encode(body);
		return new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bytes);
				controller.close();
			}
		});
	}
	return body;
};

const headFromOutput = (
	key: string,
	out: S3HeadOutput | S3GetOutput | null
): BlobObject | null => {
	if (out === null) return null;
	const result: BlobObject = {
		key,
		size: out.ContentLength ?? 0
	};
	if (out.ContentType !== undefined) result.contentType = out.ContentType;
	if (out.ETag !== undefined) result.etag = out.ETag.replace(/^"|"$/g, '');
	if (out.LastModified !== undefined) {
		result.lastModified = out.LastModified.getTime();
	}
	if (out.Metadata !== undefined && Object.keys(out.Metadata).length > 0) {
		result.metadata = out.Metadata;
	}
	return result;
};

/** Many S3 SDKs throw a structured "not found" error rather than returning null. */
const isNotFoundError = (error: unknown): boolean => {
	if (error === null || typeof error !== 'object') return false;
	const errorObj = error as {
		name?: string;
		Code?: string;
		$metadata?: { httpStatusCode?: number };
	};
	if (errorObj.name === 'NoSuchKey' || errorObj.name === 'NotFound') return true;
	if (errorObj.Code === 'NoSuchKey' || errorObj.Code === 'NotFound') return true;
	if (errorObj.$metadata?.httpStatusCode === 404) return true;
	return false;
};

export const s3BlobStore = (options: S3BlobStoreOptions): BlobStore => {
	const { client, bucket } = options;
	const label = options.label ?? `s3 bucket "${bucket}"`;

	const put = async (
		key: string,
		body: BlobBody,
		putOptions: PutOptions = {}
	): Promise<BlobObject> => {
		validateKey(key);
		const bytes = await collectBody(body);
		const input: S3PutInput = {
			Body: bytes,
			Bucket: bucket,
			Key: key
		};
		if (putOptions.contentType !== undefined) {
			input.ContentType = putOptions.contentType;
		}
		if (putOptions.metadata !== undefined) input.Metadata = putOptions.metadata;
		if (putOptions.cacheControl !== undefined) {
			input.CacheControl = putOptions.cacheControl;
		}
		if (putOptions.contentDisposition !== undefined) {
			input.ContentDisposition = putOptions.contentDisposition;
		}
		const output = await client.putObject(input);
		const result: BlobObject = {
			key,
			lastModified: Date.now(),
			size: bytes.length
		};
		if (output.ETag !== undefined) result.etag = output.ETag.replace(/^"|"$/g, '');
		if (putOptions.contentType !== undefined) {
			result.contentType = putOptions.contentType;
		}
		if (putOptions.metadata !== undefined) result.metadata = putOptions.metadata;
		return result;
	};

	const get = async (key: string): Promise<Uint8Array | null> => {
		validateKey(key);
		try {
			const out = await client.getObject({ Bucket: bucket, Key: key });
			if (out === null) return null;
			return await bytesFromGetBody(out.Body);
		} catch (error) {
			if (isNotFoundError(error)) return null;
			throw error;
		}
	};

	const getStream = async (
		key: string
	): Promise<ReadableStream<Uint8Array> | null> => {
		validateKey(key);
		try {
			const out = await client.getObject({ Bucket: bucket, Key: key });
			if (out === null) return null;
			return streamFromGetBody(out.Body);
		} catch (error) {
			if (isNotFoundError(error)) return null;
			throw error;
		}
	};

	const head = async (key: string): Promise<BlobObject | null> => {
		validateKey(key);
		try {
			const out = await client.headObject({ Bucket: bucket, Key: key });
			return headFromOutput(key, out);
		} catch (error) {
			if (isNotFoundError(error)) return null;
			throw error;
		}
	};

	const delete_ = async (key: string): Promise<void> => {
		validateKey(key);
		try {
			await client.deleteObject({ Bucket: bucket, Key: key });
		} catch (error) {
			if (isNotFoundError(error)) return;
			throw error;
		}
	};

	const list = async (
		listOptions: ListOptions = {}
	): Promise<ListResult> => {
		const input: S3ListInput = { Bucket: bucket };
		if (listOptions.prefix !== undefined) input.Prefix = listOptions.prefix;
		if (listOptions.cursor !== undefined) {
			input.ContinuationToken = listOptions.cursor;
		}
		if (listOptions.limit !== undefined) input.MaxKeys = listOptions.limit;
		const out = await client.listObjectsV2(input);
		const objects: BlobObject[] = (out.Contents ?? [])
			.filter((c): c is S3ListItem & { Key: string } => c.Key !== undefined)
			.map((c) => {
				const result: BlobObject = {
					key: c.Key,
					size: c.Size ?? 0
				};
				if (c.ETag !== undefined) result.etag = c.ETag.replace(/^"|"$/g, '');
				if (c.LastModified !== undefined) {
					result.lastModified = c.LastModified.getTime();
				}
				return result;
			});
		const result: ListResult = {
			objects,
			truncated: out.IsTruncated === true
		};
		if (out.NextContinuationToken !== undefined) {
			result.cursor = out.NextContinuationToken;
		}
		return result;
	};

	const presign = async (
		key: string,
		presignOptions: PresignOptions = {}
	): Promise<string> => {
		validateKey(key);
		const ttl = presignOptions.ttlSeconds ?? 3600;
		const operation = presignOptions.operation ?? 'get';
		if (operation === 'put') {
			const input: S3PresignInput = { Bucket: bucket, Key: key };
			if (presignOptions.contentType !== undefined) {
				input.ContentType = presignOptions.contentType;
			}
			return client.presignPutObject(input, { expiresIn: ttl });
		}
		return client.presignGetObject(
			{ Bucket: bucket, Key: key },
			{ expiresIn: ttl }
		);
	};

	const description = label;
	void BlobError; // re-exported via root; suppress unused-import warning
	return {
		delete: delete_,
		description,
		get,
		getStream,
		head,
		list,
		presign,
		put
	};
};
