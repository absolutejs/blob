import {
  CreateBucketCommand,
  DeleteBucketCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { describe, expect, test } from "bun:test";
import { awsS3BlobStore } from "../src/aws-s3";

const integrationTest = process.env.S3_TEST_ENDPOINT ? test : test.skip;

describe("awsS3BlobStore", () => {
  integrationTest(
    "streams multipart artifacts through an S3-compatible service",
    async () => {
      const bucket = `absolute-blob-${crypto.randomUUID()}`;
      const client = new S3Client({
        credentials: {
          accessKeyId: process.env.S3_TEST_ACCESS_KEY ?? "absolute-test",
          secretAccessKey:
            process.env.S3_TEST_SECRET_KEY ?? "absolute-test-secret",
        },
        endpoint: process.env.S3_TEST_ENDPOINT,
        forcePathStyle: true,
        region: "us-east-1",
      });
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
      const store = awsS3BlobStore({ bucket, client });
      const chunk = new Uint8Array(1024 * 1024).fill(42);
      const parts = 12;
      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let index = 0; index < parts; index += 1)
            controller.enqueue(chunk);
          controller.close();
        },
      });

      try {
        await expect(
          store.put("oversized.bin", new Blob(["too large"]).stream(), {
            maxBytes: 4,
          }),
        ).rejects.toThrow("exceeds 4 bytes");
        expect(await store.head("oversized.bin")).toBeNull();
        const stored = await store.put("releases/artifact.tgz", source, {
          contentType: "application/gzip",
          metadata: { sha256: "test-digest" },
        });
        expect(stored.size).toBe(chunk.byteLength * parts);
        const head = await store.head("releases/artifact.tgz");
        expect(head?.size).toBe(chunk.byteLength * parts);
        expect(head?.contentType).toBe("application/gzip");
        expect(head?.metadata).toEqual({ sha256: "test-digest" });
        const stream = await store.getStream("releases/artifact.tgz");
        let downloaded = 0;
        const reader = stream!.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          downloaded += value.byteLength;
        }
        expect(downloaded).toBe(chunk.byteLength * parts);
        expect(
          (await store.list({ prefix: "releases/" })).objects,
        ).toHaveLength(1);
        await store.delete("releases/artifact.tgz");
        expect(await store.head("releases/artifact.tgz")).toBeNull();
      } finally {
        await store.delete("oversized.bin");
        await store.delete("releases/artifact.tgz");
        await client.send(new DeleteBucketCommand({ Bucket: bucket }));
        client.destroy();
      }
    },
  );
});
