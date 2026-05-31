/**
 * @absolutejs/blob/local — filesystem adapter implementing
 * {@link BlobStore}.
 *
 * Use cases:
 *
 *   - Local dev (no AWS credentials, no docker-compose minio).
 *   - Single-host production where the box is the source of truth
 *     and you don't need a CDN.
 *   - Tests — point at a tmpdir.
 *
 * Layout: files live at `<root>/<key>`. Metadata (contentType,
 * user metadata, cacheControl, etc.) lives next to the file as
 * `<root>/<key>.meta.json`. `head()` reads only the metadata file;
 * `get()` reads the body.
 *
 * `presign()` throws — the filesystem has no equivalent of a
 * pre-signed URL. Use the S3 adapter (with a local MinIO instance
 * if you want a dev environment with presign).
 */

import { createHash } from 'node:crypto';
import {
	mkdir,
	readFile,
	readdir,
	rename,
	stat,
	unlink,
	writeFile
} from 'node:fs/promises';
import { createReadStream, type ReadStream } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { Readable } from 'node:stream';
import {
	BlobError,
	collectBody,
	validateKey,
	type BlobBody,
	type BlobObject,
	type BlobStore,
	type ListOptions,
	type ListResult,
	type PutOptions
} from './index';

export type LocalBlobStoreOptions = {
	/** Root directory blobs are stored under. Created if missing. */
	root: string;
	/**
	 * File mode for blob files. Default `0o600`. Metadata files
	 * inherit this.
	 */
	mode?: number;
};

type StoredMetadata = {
	contentType?: string;
	cacheControl?: string;
	contentDisposition?: string;
	metadata?: Record<string, string>;
};

const META_SUFFIX = '.meta.json';

const join_ = (root: string, key: string): string => {
	// We've already validated the key — splitting on '/' to use as path
	// segments is safe.
	return join(root, ...key.split('/'));
};

const md5Hex = (bytes: Uint8Array): string =>
	createHash('md5').update(bytes).digest('hex');

const readMeta = async (
	bodyPath: string
): Promise<StoredMetadata | undefined> => {
	const metaPath = `${bodyPath}${META_SUFFIX}`;
	try {
		const text = await readFile(metaPath, 'utf8');
		return JSON.parse(text) as StoredMetadata;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
		throw error;
	}
};

const writeMeta = async (
	bodyPath: string,
	meta: StoredMetadata,
	mode: number
): Promise<void> => {
	const metaPath = `${bodyPath}${META_SUFFIX}`;
	const tempPath = `${metaPath}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
	await writeFile(tempPath, JSON.stringify(meta), { mode });
	await rename(tempPath, metaPath);
};

const collectBlobObject = async (
	bodyPath: string,
	key: string
): Promise<BlobObject | null> => {
	let bodyStat: Awaited<ReturnType<typeof stat>>;
	try {
		bodyStat = await stat(bodyPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
	const meta = (await readMeta(bodyPath)) ?? {};
	const result: BlobObject = {
		key,
		lastModified: bodyStat.mtimeMs,
		size: bodyStat.size
	};
	if (meta.contentType !== undefined) result.contentType = meta.contentType;
	if (meta.metadata !== undefined) result.metadata = meta.metadata;
	return result;
};

/**
 * Build a filesystem-backed `BlobStore`. Calls `mkdir -p` for the
 * root on first write — no need to pre-create it.
 */
export const localBlobStore = (
	options: LocalBlobStoreOptions
): BlobStore => {
	const mode = options.mode ?? 0o600;
	let rootEnsured = false;

	const ensureRoot = async (): Promise<void> => {
		if (rootEnsured) return;
		await mkdir(options.root, { recursive: true });
		rootEnsured = true;
	};

	const put = async (
		key: string,
		body: BlobBody,
		putOptions: PutOptions = {}
	): Promise<BlobObject> => {
		validateKey(key);
		await ensureRoot();
		const bodyPath = join_(options.root, key);
		await mkdir(dirname(bodyPath), { recursive: true });

		const bytes = await collectBody(body);
		const tempPath = `${bodyPath}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
		await writeFile(tempPath, bytes, { mode });
		await rename(tempPath, bodyPath);

		const meta: StoredMetadata = {};
		if (putOptions.contentType !== undefined) {
			meta.contentType = putOptions.contentType;
		}
		if (putOptions.cacheControl !== undefined) {
			meta.cacheControl = putOptions.cacheControl;
		}
		if (putOptions.contentDisposition !== undefined) {
			meta.contentDisposition = putOptions.contentDisposition;
		}
		if (putOptions.metadata !== undefined) {
			meta.metadata = putOptions.metadata;
		}
		if (Object.keys(meta).length > 0) {
			await writeMeta(bodyPath, meta, mode);
		}

		const stored: BlobObject = {
			etag: md5Hex(bytes),
			key,
			lastModified: Date.now(),
			size: bytes.length
		};
		if (putOptions.contentType !== undefined) {
			stored.contentType = putOptions.contentType;
		}
		if (putOptions.metadata !== undefined) {
			stored.metadata = putOptions.metadata;
		}
		return stored;
	};

	const get = async (key: string): Promise<Uint8Array | null> => {
		validateKey(key);
		try {
			const bytes = await readFile(join_(options.root, key));
			return new Uint8Array(bytes);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
			throw error;
		}
	};

	const getStream = async (
		key: string
	): Promise<ReadableStream<Uint8Array> | null> => {
		validateKey(key);
		const bodyPath = join_(options.root, key);
		try {
			await stat(bodyPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
			throw error;
		}
		const nodeStream: ReadStream = createReadStream(bodyPath);
		return Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;
	};

	const head = async (key: string): Promise<BlobObject | null> => {
		validateKey(key);
		return collectBlobObject(join_(options.root, key), key);
	};

	const delete_ = async (key: string): Promise<void> => {
		validateKey(key);
		const bodyPath = join_(options.root, key);
		try {
			await unlink(bodyPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}
		try {
			await unlink(`${bodyPath}${META_SUFFIX}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}
	};

	const list = async (
		listOptions: ListOptions = {}
	): Promise<ListResult> => {
		await ensureRoot();
		const limit = listOptions.limit ?? 1000;
		const allKeys: string[] = [];
		// Recursive walk. Skip .meta.json companions and temp files.
		const walk = async (dir: string): Promise<void> => {
			let entries;
			try {
				entries = await readdir(dir, { withFileTypes: true });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
				throw error;
			}
			for (const entry of entries) {
				const path = join(dir, entry.name);
				if (entry.isDirectory()) {
					await walk(path);
				} else if (entry.isFile()) {
					if (entry.name.endsWith(META_SUFFIX)) continue;
					if (entry.name.includes('.tmp.')) continue;
					const key = relative(options.root, path).split(sep).join('/');
					allKeys.push(key);
				}
			}
		};
		await walk(options.root);
		allKeys.sort();

		// Filter + paginate.
		const filtered =
			listOptions.prefix !== undefined
				? allKeys.filter((k) => k.startsWith(listOptions.prefix!))
				: allKeys;
		const startIndex =
			listOptions.cursor !== undefined
				? filtered.findIndex((k) => k > listOptions.cursor!) >= 0
					? filtered.findIndex((k) => k > listOptions.cursor!)
					: filtered.length
				: 0;
		const page = filtered.slice(startIndex, startIndex + limit);

		const objects: BlobObject[] = [];
		for (const key of page) {
			const bodyPath = join_(options.root, key);
			const obj = await collectBlobObject(bodyPath, key);
			if (obj !== null) objects.push(obj);
		}

		const truncated = startIndex + limit < filtered.length;
		const result: ListResult = {
			objects,
			truncated
		};
		if (truncated && page.length > 0) {
			result.cursor = page[page.length - 1] as string;
		}
		return result;
	};

	const presign = async (): Promise<string> => {
		throw new BlobError(
			'[blob/local] filesystem store does not support presigned URLs — use the S3 adapter against a local MinIO if you need them',
			'UNSUPPORTED'
		);
	};

	const close = async (): Promise<void> => {
		// no-op — node:fs has no handles to release here
	};
	void close;

	return {
		delete: delete_,
		description: `local blob store at ${options.root}`,
		get,
		getStream,
		head,
		list,
		presign,
		put
	};
};
