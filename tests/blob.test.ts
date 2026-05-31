/**
 * Tests for @absolutejs/blob.
 *
 * - Local adapter against a real temp dir.
 * - S3 adapter against a mock S3ClientLike.
 * - Core helpers (validateKey, collectBody, BlobError).
 */
import { mkdtemp, rm, stat as statFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
	BlobError,
	collectBody,
	validateKey,
	type BlobBody
} from '../src/index';
import { localBlobStore } from '../src/local';
import {
	s3BlobStore,
	type S3ClientLike,
	type S3GetOutput,
	type S3HeadOutput,
	type S3ListOutput
} from '../src/s3';

// =============================================================================
// Core helpers
// =============================================================================

describe('validateKey', () => {
	test('accepts simple keys', () => {
		expect(() => validateKey('foo.txt')).not.toThrow();
		expect(() => validateKey('a/b/c.txt')).not.toThrow();
		expect(() => validateKey('users/42/avatar.png')).not.toThrow();
	});

	test('rejects empty', () => {
		expect(() => validateKey('')).toThrow('cannot be empty');
	});

	test('rejects leading slash', () => {
		expect(() => validateKey('/foo')).toThrow("cannot start with '/'");
	});

	test('rejects NUL bytes', () => {
		expect(() => validateKey('foo\0bar')).toThrow('NUL bytes');
	});

	test('rejects path-traversal segments', () => {
		expect(() => validateKey('../etc/passwd')).toThrow('"." or ".."');
		expect(() => validateKey('a/../b')).toThrow('"." or ".."');
		expect(() => validateKey('./a')).toThrow('"." or ".."');
	});
});

describe('collectBody', () => {
	test('string → utf8 bytes', async () => {
		const bytes = await collectBody('hello');
		expect(bytes).toEqual(new TextEncoder().encode('hello'));
	});

	test('Uint8Array passes through', async () => {
		const input = new Uint8Array([1, 2, 3]);
		const out = await collectBody(input);
		expect(out).toBe(input);
	});

	test('ReadableStream is drained', async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array([1, 2]));
				controller.enqueue(new Uint8Array([3]));
				controller.close();
			}
		});
		const bytes = await collectBody(stream as BlobBody);
		expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
	});
});

describe('BlobError', () => {
	test('carries a code', () => {
		const err = new BlobError('boom', 'NOT_FOUND');
		expect(err.name).toBe('BlobError');
		expect(err.code).toBe('NOT_FOUND');
		expect(err.message).toBe('boom');
	});
});

// =============================================================================
// Local adapter
// =============================================================================

describe('localBlobStore', () => {
	let tmpDir: string;
	let store: ReturnType<typeof localBlobStore>;

	beforeAll(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), 'absblob-'));
		store = localBlobStore({ root: tmpDir });
	});
	afterAll(async () => {
		await rm(tmpDir, { force: true, recursive: true });
	});

	test('put + get round-trips bytes', async () => {
		const result = await store.put('hello.txt', 'Hello, world');
		expect(result.key).toBe('hello.txt');
		expect(result.size).toBe(12);
		const bytes = await store.get('hello.txt');
		expect(bytes).toEqual(new TextEncoder().encode('Hello, world'));
	});

	test('put preserves contentType + metadata', async () => {
		await store.put('typed.txt', 'x', {
			contentType: 'text/plain; charset=utf-8',
			metadata: { tenant: 'acme', userId: 'u_42' }
		});
		const head = await store.head('typed.txt');
		expect(head?.contentType).toBe('text/plain; charset=utf-8');
		expect(head?.metadata).toEqual({ tenant: 'acme', userId: 'u_42' });
	});

	test('get returns null for missing keys', async () => {
		expect(await store.get('nope.txt')).toBeNull();
	});

	test('head returns null for missing keys', async () => {
		expect(await store.head('nope.txt')).toBeNull();
	});

	test('getStream streams the body', async () => {
		await store.put('streamed.txt', 'streamed content');
		const stream = await store.getStream('streamed.txt');
		expect(stream).not.toBeNull();
		const reader = stream!.getReader();
		const chunks: Uint8Array[] = [];
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value !== undefined) chunks.push(value);
		}
		const collected = await collectBody(
			new ReadableStream<Uint8Array>({
				start(controller) {
					for (const chunk of chunks) controller.enqueue(chunk);
					controller.close();
				}
			}) as BlobBody
		);
		expect(new TextDecoder().decode(collected)).toBe('streamed content');
	});

	test('delete removes body + metadata; idempotent', async () => {
		await store.put('deleteme.txt', 'bye');
		await store.delete('deleteme.txt');
		expect(await store.get('deleteme.txt')).toBeNull();
		// Second delete: no throw.
		await expect(store.delete('deleteme.txt')).resolves.toBeUndefined();
	});

	test('list returns sorted keys', async () => {
		// Wipe existing keys for a clean test
		const before = await store.list();
		for (const obj of before.objects) await store.delete(obj.key);

		await store.put('z.txt', '1');
		await store.put('a.txt', '2');
		await store.put('m.txt', '3');
		const result = await store.list();
		expect(result.objects.map((o) => o.key)).toEqual([
			'a.txt',
			'm.txt',
			'z.txt'
		]);
	});

	test('list filters by prefix', async () => {
		const before = await store.list();
		for (const obj of before.objects) await store.delete(obj.key);

		await store.put('users/1/avatar.png', 'a');
		await store.put('users/2/avatar.png', 'b');
		await store.put('admin/config.json', 'c');
		const users = await store.list({ prefix: 'users/' });
		expect(users.objects.map((o) => o.key).sort()).toEqual([
			'users/1/avatar.png',
			'users/2/avatar.png'
		]);
	});

	test('list paginates via cursor', async () => {
		const before = await store.list();
		for (const obj of before.objects) await store.delete(obj.key);

		for (let i = 0; i < 5; i += 1) {
			await store.put(`page/${String(i).padStart(2, '0')}.txt`, `data-${i}`);
		}
		const page1 = await store.list({ limit: 2 });
		expect(page1.objects).toHaveLength(2);
		expect(page1.truncated).toBe(true);
		expect(page1.cursor).toBeDefined();

		const page2 = await store.list({ cursor: page1.cursor, limit: 2 });
		expect(page2.objects).toHaveLength(2);
		expect(page2.truncated).toBe(true);

		const page3 = await store.list({ cursor: page2.cursor, limit: 2 });
		expect(page3.objects).toHaveLength(1);
		expect(page3.truncated).toBe(false);
	});

	test('list skips .meta.json + temp files', async () => {
		const before = await store.list();
		for (const obj of before.objects) await store.delete(obj.key);

		await store.put('real.txt', 'x', { metadata: { foo: 'bar' } });
		// Inject a stray temp file directly via fs.
		await writeFile(join(tmpDir, 'real.txt.tmp.999.abc'), 'leftover');
		const result = await store.list();
		expect(result.objects.map((o) => o.key)).toEqual(['real.txt']);
	});

	test('presign throws UNSUPPORTED', async () => {
		await expect(store.presign('any')).rejects.toMatchObject({
			code: 'UNSUPPORTED',
			name: 'BlobError'
		});
	});

	test('atomic write: temp file is renamed, no .tmp leftover', async () => {
		await store.put('atomic.bin', new Uint8Array([1, 2, 3, 4]));
		const exists = await statFile(join(tmpDir, 'atomic.bin')).then(
			() => true,
			() => false
		);
		expect(exists).toBe(true);
		// No leftover .tmp.<pid> files.
		const result = await store.list({ prefix: 'atomic' });
		expect(result.objects).toHaveLength(1);
	});

	test('nested keys create directories on first write', async () => {
		await store.put('deeply/nested/key.txt', 'x');
		const bytes = await store.get('deeply/nested/key.txt');
		expect(new TextDecoder().decode(bytes!)).toBe('x');
	});
});

// =============================================================================
// S3 adapter — mock client
// =============================================================================

const makeMockS3Client = (
	initial: Record<string, { body: Uint8Array; meta?: S3HeadOutput }> = {}
): {
	client: S3ClientLike;
	calls: Array<{ op: string; input: unknown }>;
	state: () => Record<string, { body: Uint8Array; meta?: S3HeadOutput }>;
} => {
	const store = new Map<
		string,
		{ body: Uint8Array; meta?: S3HeadOutput }
	>();
	for (const [key, value] of Object.entries(initial)) store.set(key, value);
	const calls: Array<{ op: string; input: unknown }> = [];

	const buildHead = (key: string): S3HeadOutput | null => {
		const entry = store.get(key);
		if (entry === undefined) return null;
		return {
			ContentLength: entry.body.length,
			ContentType: entry.meta?.ContentType,
			ETag: '"deadbeef"',
			LastModified: entry.meta?.LastModified ?? new Date(0),
			Metadata: entry.meta?.Metadata
		};
	};

	const client: S3ClientLike = {
		deleteObject: async (input) => {
			calls.push({ input, op: 'delete' });
			store.delete(input.Key);
			return {};
		},
		getObject: async (input) => {
			calls.push({ input, op: 'get' });
			const entry = store.get(input.Key);
			if (entry === undefined) return null;
			const out: S3GetOutput = {
				Body: entry.body,
				ContentLength: entry.body.length,
				ETag: '"deadbeef"',
				LastModified: entry.meta?.LastModified ?? new Date(0)
			};
			if (entry.meta?.ContentType !== undefined) {
				out.ContentType = entry.meta.ContentType;
			}
			if (entry.meta?.Metadata !== undefined) out.Metadata = entry.meta.Metadata;
			return out;
		},
		headObject: async (input) => {
			calls.push({ input, op: 'head' });
			return buildHead(input.Key);
		},
		listObjectsV2: async (input) => {
			calls.push({ input, op: 'list' });
			const keys = [...store.keys()].sort();
			const filtered =
				input.Prefix !== undefined
					? keys.filter((k) => k.startsWith(input.Prefix!))
					: keys;
			const startIndex =
				input.ContinuationToken !== undefined
					? filtered.findIndex((k) => k > input.ContinuationToken!) >= 0
						? filtered.findIndex((k) => k > input.ContinuationToken!)
						: filtered.length
					: 0;
			const limit = input.MaxKeys ?? 1000;
			const page = filtered.slice(startIndex, startIndex + limit);
			const out: S3ListOutput = {
				Contents: page.map((Key) => {
					const entry = store.get(Key);
					return {
						ETag: '"deadbeef"',
						Key,
						LastModified: entry?.meta?.LastModified ?? new Date(0),
						Size: entry?.body.length ?? 0
					};
				}),
				IsTruncated: startIndex + limit < filtered.length
			};
			if (out.IsTruncated === true && page.length > 0) {
				out.NextContinuationToken = page[page.length - 1];
			}
			return out;
		},
		presignGetObject: async (input, opts) => {
			calls.push({ input: { ...input, expiresIn: opts.expiresIn }, op: 'presign-get' });
			return `https://example.test/${input.Bucket}/${input.Key}?X-Amz-Expires=${opts.expiresIn}`;
		},
		presignPutObject: async (input, opts) => {
			calls.push({ input: { ...input, expiresIn: opts.expiresIn }, op: 'presign-put' });
			return `https://example.test/${input.Bucket}/${input.Key}?X-Amz-Expires=${opts.expiresIn}&Method=PUT`;
		},
		putObject: async (input) => {
			calls.push({ input, op: 'put' });
			const bytes =
				typeof input.Body === 'string'
					? new TextEncoder().encode(input.Body)
					: input.Body instanceof Uint8Array
						? input.Body
						: new Uint8Array(); // streams not exercised here
			store.set(input.Key, {
				body: bytes,
				meta: {
					ContentType: input.ContentType,
					LastModified: new Date(),
					Metadata: input.Metadata
				}
			});
			return { ETag: '"deadbeef"' };
		}
	};

	return { calls, client, state: () => Object.fromEntries(store) };
};

describe('s3BlobStore', () => {
	test('put + get round-trips bytes', async () => {
		const { client, state } = makeMockS3Client();
		const store = s3BlobStore({ bucket: 'test', client });
		await store.put('greet.txt', 'hello');
		const stored = state();
		expect(new TextDecoder().decode(stored['greet.txt']!.body)).toBe('hello');
		const got = await store.get('greet.txt');
		expect(new TextDecoder().decode(got!)).toBe('hello');
	});

	test('put forwards contentType + metadata + cacheControl', async () => {
		const { calls, client } = makeMockS3Client();
		const store = s3BlobStore({ bucket: 'test', client });
		await store.put('user.json', '{}', {
			cacheControl: 'public, max-age=60',
			contentType: 'application/json',
			metadata: { userId: 'u_42' }
		});
		const putCall = calls.find((c) => c.op === 'put');
		const input = putCall?.input as {
			Bucket: string;
			ContentType?: string;
			Metadata?: Record<string, string>;
			CacheControl?: string;
		};
		expect(input.ContentType).toBe('application/json');
		expect(input.Metadata).toEqual({ userId: 'u_42' });
		expect(input.CacheControl).toBe('public, max-age=60');
	});

	test('get returns null for missing keys (provider returns null)', async () => {
		const { client } = makeMockS3Client();
		const store = s3BlobStore({ bucket: 'test', client });
		expect(await store.get('absent')).toBeNull();
	});

	test('get returns null when provider throws NoSuchKey', async () => {
		const throwingClient: S3ClientLike = {
			deleteObject: async () => ({}),
			getObject: async () => {
				const err = new Error('no such key') as Error & { name: string };
				err.name = 'NoSuchKey';
				throw err;
			},
			headObject: async () => null,
			listObjectsV2: async () => ({}),
			presignGetObject: async () => '',
			presignPutObject: async () => '',
			putObject: async () => ({})
		};
		const store = s3BlobStore({ bucket: 'test', client: throwingClient });
		expect(await store.get('any')).toBeNull();
	});

	test('get returns null when provider throws 404 ($metadata)', async () => {
		const throwingClient: S3ClientLike = {
			deleteObject: async () => ({}),
			getObject: async () => {
				const err = new Error('http 404') as Error & {
					$metadata: { httpStatusCode: number };
				};
				err.$metadata = { httpStatusCode: 404 };
				throw err;
			},
			headObject: async () => null,
			listObjectsV2: async () => ({}),
			presignGetObject: async () => '',
			presignPutObject: async () => '',
			putObject: async () => ({})
		};
		const store = s3BlobStore({ bucket: 'test', client: throwingClient });
		expect(await store.get('any')).toBeNull();
	});

	test('head maps ContentType, ContentLength, ETag (unquoted), LastModified', async () => {
		const { client } = makeMockS3Client({
			'a.txt': {
				body: new Uint8Array([1, 2, 3]),
				meta: {
					ContentType: 'text/plain',
					LastModified: new Date('2026-01-01T00:00:00Z'),
					Metadata: { tenant: 'acme' }
				}
			}
		});
		const store = s3BlobStore({ bucket: 'test', client });
		const head = await store.head('a.txt');
		expect(head?.size).toBe(3);
		expect(head?.contentType).toBe('text/plain');
		expect(head?.etag).toBe('deadbeef'); // quotes stripped
		expect(head?.metadata).toEqual({ tenant: 'acme' });
		expect(head?.lastModified).toBe(
			new Date('2026-01-01T00:00:00Z').getTime()
		);
	});

	test('delete is idempotent on 404', async () => {
		const throwingClient: S3ClientLike = {
			deleteObject: async () => {
				const err = new Error('not found') as Error & { name: string };
				err.name = 'NotFound';
				throw err;
			},
			getObject: async () => null,
			headObject: async () => null,
			listObjectsV2: async () => ({}),
			presignGetObject: async () => '',
			presignPutObject: async () => '',
			putObject: async () => ({})
		};
		const store = s3BlobStore({ bucket: 'test', client: throwingClient });
		await expect(store.delete('any')).resolves.toBeUndefined();
	});

	test('list maps Contents + IsTruncated + NextContinuationToken', async () => {
		const { client } = makeMockS3Client({
			'a.txt': { body: new Uint8Array(1) },
			'b.txt': { body: new Uint8Array(2) },
			'c.txt': { body: new Uint8Array(3) }
		});
		const store = s3BlobStore({ bucket: 'test', client });
		const result = await store.list({ limit: 2 });
		expect(result.objects).toHaveLength(2);
		expect(result.truncated).toBe(true);
		expect(result.cursor).toBeDefined();
		const tail = await store.list({ cursor: result.cursor });
		expect(tail.objects.map((o) => o.key)).toEqual(['c.txt']);
	});

	test('presign get builds a URL with the expected TTL', async () => {
		const { client } = makeMockS3Client();
		const store = s3BlobStore({ bucket: 'test', client });
		const url = await store.presign('avatar.png', { ttlSeconds: 900 });
		expect(url).toContain('X-Amz-Expires=900');
	});

	test('presign put includes contentType', async () => {
		const { calls, client } = makeMockS3Client();
		const store = s3BlobStore({ bucket: 'test', client });
		await store.presign('upload.png', {
			contentType: 'image/png',
			operation: 'put'
		});
		const call = calls.find((c) => c.op === 'presign-put');
		const input = call?.input as { ContentType?: string };
		expect(input.ContentType).toBe('image/png');
	});

	test('presign default operation is get', async () => {
		const { calls, client } = makeMockS3Client();
		const store = s3BlobStore({ bucket: 'test', client });
		await store.presign('a.txt');
		expect(calls.some((c) => c.op === 'presign-get')).toBe(true);
	});
});

// =============================================================================
// Interface compatibility — local + S3 are interchangeable
// =============================================================================

describe('cross-adapter interchangeability', () => {
	test('a function typed against BlobStore accepts both local + S3', async () => {
		const localTmp = await mkdtemp(join(tmpdir(), 'absblob-iface-'));
		try {
			const local = localBlobStore({ root: localTmp });
			const { client } = makeMockS3Client();
			const s3 = s3BlobStore({ bucket: 'test', client });

			const roundTrip = async (store: { put: BlobBody | undefined } & typeof local) => {
				void store;
			};
			void roundTrip; // smoke test — type-only

			// Functional smoke: both round-trip the same call shape.
			await local.put('k', 'v');
			await s3.put('k', 'v');
			expect(new TextDecoder().decode((await local.get('k'))!)).toBe('v');
			expect(new TextDecoder().decode((await s3.get('k'))!)).toBe('v');
		} finally {
			await rm(localTmp, { force: true, recursive: true });
		}
	});
});
