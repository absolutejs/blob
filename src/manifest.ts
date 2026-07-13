import {
	defineImplementation,
	defineManifest,
	toolFactory
} from '@absolutejs/manifest';
import { Type } from '@sinclair/typebox';
import type { BlobStore } from './index';
import type { LocalBlobStoreOptions } from './local';

const tool = toolFactory<BlobStore>();

/* Blob has no serializable top-level config: the store IS the instance, so
 * the single `$self` slot picks which adapter builds it. */
export const manifest = defineManifest<Record<never, never>, BlobStore>()({
	contract: 1,
	identity: {
		accent: '#f59e0b',
		category: 'storage',
		description:
			'One `BlobStore` interface (put/get/getStream/head/delete/list/presign) with adapters for local disk and every S3-compatible service. Swapping providers is one constructor change.',
		docsUrl: 'https://github.com/absolutejs/blob',
		name: '@absolutejs/blob',
		tagline: 'Store and serve files — images, uploads, documents.'
	},
	implements: [
		defineImplementation<LocalBlobStoreOptions>()({
			contract: 'blob/store',
			factory: 'localBlobStore',
			from: '@absolutejs/blob/local',
			settings: Type.Object({
				root: Type.String({
					default: './var/blobs',
					description:
						'Folder on this machine where files are kept. Created if missing.',
					title: 'Storage folder'
				})
			}),
			title: 'This machine (good for development)',
			wiring: {
				code: 'localBlobStore(${settings})',
				imports: [
					{ from: '@absolutejs/blob/local', names: ['localBlobStore'] }
				]
			}
		}),
		{
			contract: 'blob/store',
			factory: 's3BlobStore',
			from: '@absolutejs/blob/s3',
			requires: {
				env: [
					{
						description: 'Access key id for your storage provider',
						key: 'S3_ACCESS_KEY_ID',
						secret: true
					},
					{
						description: 'Secret access key for your storage provider',
						key: 'S3_SECRET_ACCESS_KEY',
						secret: true
					}
				],
				peers: [
					{
						name: '@aws-sdk/client-s3',
						range: '^3.0.0',
						reason: 'S3 wire protocol client'
					},
					{
						name: '@aws-sdk/s3-request-presigner',
						range: '^3.0.0',
						reason: 'Direct-to-browser upload/download URLs'
					}
				]
			},
			settings: Type.Object({
				bucket: Type.String({
					description: 'The bucket files are stored in.',
					title: 'Bucket name'
				}),
				endpoint: Type.Optional(
					Type.String({
						description:
							'Only needed for non-AWS providers (Cloudflare R2, Backblaze B2, MinIO, Wasabi).',
						examples: ['https://<account>.r2.cloudflarestorage.com'],
						format: 'uri',
						title: 'Service URL'
					})
				),
				region: Type.Optional(
					Type.String({
						default: 'auto',
						description: "Your provider's region. Use 'auto' for R2.",
						title: 'Region'
					})
				)
			}),
			title: 'Cloud storage (AWS S3, Cloudflare R2, Backblaze B2, MinIO)',
			wiring: {
				code: [
					'(() => {',
					'\tconst aws = new S3Client({',
					'\t\tcredentials: {',
					'\t\t\taccessKeyId: ${env.S3_ACCESS_KEY_ID} ?? "",',
					'\t\t\tsecretAccessKey: ${env.S3_SECRET_ACCESS_KEY} ?? ""',
					'\t\t},',
					'\t\tendpoint: ${settings.endpoint},',
					'\t\tregion: ${settings.region}',
					'\t});',
					'\tconst client: S3ClientLike = {',
					'\t\tdeleteObject: (i) => aws.send(new DeleteObjectCommand(i as never)) as never,',
					'\t\tgetObject: (i) => aws.send(new GetObjectCommand(i as never)) as never,',
					'\t\theadObject: (i) => aws.send(new HeadObjectCommand(i as never)) as never,',
					'\t\tlistObjectsV2: (i) => aws.send(new ListObjectsV2Command(i as never)) as never,',
					'\t\tpresignGetObject: (i, o) => getSignedUrl(aws as never, new GetObjectCommand(i as never), o),',
					'\t\tpresignPutObject: (i, o) => getSignedUrl(aws as never, new PutObjectCommand(i as never), o),',
					'\t\tputObject: (i) => aws.send(new PutObjectCommand(i as never)) as never',
					'\t};',
					'\treturn s3BlobStore({ bucket: ${settings.bucket}, client });',
					'})()'
				].join('\n'),
				imports: [
					{
						from: '@aws-sdk/client-s3',
						names: [
							'DeleteObjectCommand',
							'GetObjectCommand',
							'HeadObjectCommand',
							'ListObjectsV2Command',
							'PutObjectCommand',
							'S3Client'
						]
					},
					{ from: '@aws-sdk/s3-request-presigner', names: ['getSignedUrl'] },
					{
						from: '@absolutejs/blob/s3',
						names: ['s3BlobStore']
					},
					{
						from: '@absolutejs/blob/s3',
						names: ['S3ClientLike'],
						typeOnly: true
					}
				]
			}
		}
	],
	settings: Type.Object({}),
	slots: {
		store: {
			configPath: '$self',
			contract: 'blob/store',
			description: 'Where your files live',
			known: ['@absolutejs/blob#local', '@absolutejs/blob#s3'],
			required: true
		}
	},
	tools: {
		delete_file: tool.runtime({
			annotations: { destructiveHint: true, idempotentHint: true },
			description:
				'Delete one stored file by key. Deleting a missing key succeeds (idempotent).',
			handler: async ({ key }, store) => {
				await store.delete(key);

				return `deleted ${key}`;
			},
			input: Type.Object({ key: Type.String({ minLength: 1 }) })
		}),
		file_info: tool.runtime({
			annotations: { readOnlyHint: true },
			description:
				'Get metadata (size, type, last modified) for one stored file, without downloading it.',
			handler: async ({ key }, store) => {
				const object = await store.head(key);

				return object === null
					? `no file stored at "${key}"`
					: JSON.stringify(object);
			},
			input: Type.Object({ key: Type.String({ minLength: 1 }) })
		}),
		list_files: tool.runtime({
			annotations: { readOnlyHint: true },
			description:
				'List stored files, optionally under a prefix. Returns keys, sizes, and a cursor for paging.',
			handler: async (input, store) =>
				JSON.stringify(await store.list(input)),
			input: Type.Object({
				cursor: Type.Optional(Type.String()),
				limit: Type.Optional(Type.Integer({ maximum: 1000, minimum: 1 })),
				prefix: Type.Optional(Type.String())
			})
		}),
		presign_url: tool.runtime({
			annotations: { readOnlyHint: true },
			description:
				'Create a time-limited URL a browser can use to download (get) or upload (put) a file directly. Not supported by the local-disk store.',
			handler: async ({ key, operation, ttlSeconds }, store) =>
				store.presign(key, { operation, ttlSeconds }),
			input: Type.Object({
				key: Type.String({ minLength: 1 }),
				operation: Type.Optional(
					Type.Union([Type.Literal('get'), Type.Literal('put')], {
						default: 'get'
					})
				),
				ttlSeconds: Type.Optional(
					Type.Integer({ default: 3600, maximum: 604800, minimum: 60 })
				)
			})
		})
	},
	wiring: [
		{
			id: 'default',
			server: {
				code: 'const blobs = ${slot.store};',
				imports: [],
				placement: 'module-scope'
			},
			title: 'Create a blob store'
		}
	]
});

export default manifest;
