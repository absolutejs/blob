/** Official AWS SDK wiring for AWS S3 and S3-compatible providers. */

import {
	DeleteObjectCommand,
	GetObjectCommand,
	HeadObjectCommand,
	ListObjectsV2Command,
	PutObjectCommand,
	type PutObjectCommandInput,
	type S3Client
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable, Transform } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { s3BlobStore, type S3ClientLike, type S3PutInput } from './s3';

const putInput = (
	input: S3PutInput,
	maxBytes?: number
): PutObjectCommandInput => {
	let bytes = 0;

	return {
		Body:
			input.Body instanceof ReadableStream
				? Readable.fromWeb(
						input.Body as unknown as NodeReadableStream<Uint8Array>
					).pipe(
						new Transform({
							transform(chunk: Buffer, _encoding, callback) {
								bytes += chunk.byteLength;
								if (maxBytes !== undefined && bytes > maxBytes) {
									callback(
										new Error(`blob exceeds ${maxBytes} bytes`)
									);

									return;
								}
								callback(null, chunk);
							}
						})
					)
				: input.Body,
		Bucket: input.Bucket,
		Key: input.Key,
		...(input.CacheControl ? { CacheControl: input.CacheControl } : {}),
		...(input.ContentDisposition
			? { ContentDisposition: input.ContentDisposition }
			: {}),
		...(input.ContentType ? { ContentType: input.ContentType } : {}),
		...(input.Metadata ? { Metadata: input.Metadata } : {})
	};
};

export const awsS3Client = (client: S3Client): S3ClientLike => ({
	deleteObject: (input) => client.send(new DeleteObjectCommand(input)),
	getObject: async (input) => {
		const output = await client.send(new GetObjectCommand(input));
		const body = output.Body;

		return {
			...(body ? { Body: body.transformToWebStream() } : {}),
			...(output.ContentLength === undefined
				? {}
				: { ContentLength: output.ContentLength }),
			...(output.ContentType ? { ContentType: output.ContentType } : {}),
			...(output.ETag ? { ETag: output.ETag } : {}),
			...(output.LastModified ? { LastModified: output.LastModified } : {}),
			...(output.Metadata ? { Metadata: output.Metadata } : {})
		};
	},
	headObject: async (input) => {
		const output = await client.send(new HeadObjectCommand(input));

		return {
			...(output.ContentLength === undefined
				? {}
				: { ContentLength: output.ContentLength }),
			...(output.ContentType ? { ContentType: output.ContentType } : {}),
			...(output.ETag ? { ETag: output.ETag } : {}),
			...(output.LastModified ? { LastModified: output.LastModified } : {}),
			...(output.Metadata ? { Metadata: output.Metadata } : {})
		};
	},
	listObjectsV2: async (input) => {
		const output = await client.send(new ListObjectsV2Command(input));

		return {
			...(output.Contents
				? {
						Contents: output.Contents.map((object) => ({
							...(object.ETag ? { ETag: object.ETag } : {}),
							...(object.Key ? { Key: object.Key } : {}),
							...(object.LastModified
								? { LastModified: object.LastModified }
								: {}),
							...(object.Size === undefined ? {} : { Size: object.Size })
						}))
					}
				: {}),
			...(output.IsTruncated === undefined
				? {}
				: { IsTruncated: output.IsTruncated }),
			...(output.NextContinuationToken
				? { NextContinuationToken: output.NextContinuationToken }
				: {})
		};
	},
	presignGetObject: (input, options) =>
		getSignedUrl(client, new GetObjectCommand(input), options),
	presignPutObject: (input, options) =>
		getSignedUrl(client, new PutObjectCommand(input), options),
	putObject: async (input, options) => {
		const commandInput = putInput(input, options?.maxBytes);
		if (input.Body instanceof ReadableStream) {
			const output = await new Upload({
				client,
				leavePartsOnError: false,
				params: commandInput
			}).done();

			return output.ETag ? { ETag: output.ETag } : {};
		}
		const output = await client.send(new PutObjectCommand(commandInput));

		return output.ETag ? { ETag: output.ETag } : {};
	}
});

export const awsS3BlobStore = (options: {
	bucket: string;
	client: S3Client;
	label?: string;
}) =>
	s3BlobStore({
		bucket: options.bucket,
		client: awsS3Client(options.client),
		...(options.label ? { label: options.label } : {})
	});
