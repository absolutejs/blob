import { afterEach, describe, expect, test } from "bun:test";
import {
  uploadThingBlobStore,
  type UploadThingClient,
} from "../src/uploadthing";

describe("uploadThingBlobStore", () => {
  test("stores stable custom keys and maps provider listings", async () => {
    const deleted: string[] = [];
    let uploadedCustomId: string | undefined;
    const api: UploadThingClient = {
      deleteFiles: async (keys) => {
        deleted.push(...(Array.isArray(keys) ? keys : [keys]));
        return { deletedCount: 1, success: true };
      },
      generateSignedURL: async () => ({ ufsUrl: "https://example.com/file" }),
      listFiles: async () => ({
        files: [
          {
            customId: "projects/one/image.png",
            key: "provider-key",
            name: "image.png",
            size: 3,
            status: "Uploaded",
            uploadedAt: 123,
          },
        ],
        hasMore: false,
      }),
      uploadFiles: async (file) => {
        uploadedCustomId = file.customId ?? undefined;
        return {
          data: {
            customId: file.customId ?? null,
            fileHash: "digest",
            key: "provider-key",
            name: file.name,
            size: file.size,
            type: file.type,
          },
          error: null,
        };
      },
    };
    const store = uploadThingBlobStore({ api });

    expect(
      await store.put("projects/one/image.png", new Uint8Array([1, 2, 3]), {
        contentType: "image/png",
      }),
    ).toMatchObject({ key: "projects/one/image.png", size: 3 });
    expect(uploadedCustomId).toBe("projects/one/image.png");
    expect(await store.list({ prefix: "projects/one/" })).toEqual({
      objects: [
        {
          key: "projects/one/image.png",
          lastModified: 123,
          size: 3,
        },
      ],
      truncated: false,
    });
    await store.delete("projects/one/image.png");
    expect(deleted).toEqual(["projects/one/image.png"]);
  });
});

test("private ACL is explicit, oversized streams stop before provider upload, and delete failures reject", async () => {
  let uploads = 0,
    cancelled = false;
  const api = {
    uploadFiles: async (file: any, options: any) => {
      uploads++;
      expect(options.acl).toBe("private");
      return {
        data: {
          customId: file.customId,
          fileHash: "hash",
          key: "key",
          name: file.name,
          size: file.size,
          type: file.type,
        },
        error: null,
      };
    },
    deleteFiles: async () => ({ success: false, deletedCount: 0 }),
    listFiles: async () => ({ files: [], hasMore: false }),
    generateSignedURL: async () => ({ ufsUrl: "https://example.com" }),
  };
  const store = uploadThingBlobStore({ api, acl: "private" });
  await store.put("one", new Uint8Array([1]), { maxBytes: 1 });
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      c.enqueue(new Uint8Array(10));
    },
    cancel() {
      cancelled = true;
    },
  });
  await expect(store.put("large", stream, { maxBytes: 5 })).rejects.toThrow(
    "byte limit",
  );
  expect(cancelled).toBe(true);
  expect(uploads).toBe(1);
  await expect(store.delete("one")).rejects.toThrow("deletion failed");
});

describe("byte ranges", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });
  const rangedStore = () =>
    uploadThingBlobStore({
      api: {
        generateSignedURL: async () => ({
          ufsUrl: "https://example.com/file",
        }),
        listFiles: async () => ({
          files: [
            {
              customId: "clip.mp4",
              key: "provider-key",
              name: "clip.mp4",
              size: 10,
              status: "Uploaded",
              uploadedAt: 123,
            },
          ],
          hasMore: false,
        }),
      } as unknown as UploadThingClient,
    });
  const respondWith = (status: number) => {
    const headers: (string | null)[] = [];
    globalThis.fetch = Object.assign(
      async (_input: unknown, init?: RequestInit) => {
        headers.push(new Headers(init?.headers).get("range"));

        return new Response("part", { status });
      },
      { preconnect: originalFetch.preconnect },
    );

    return headers;
  };

  test("asks the provider for the range", async () => {
    const headers = respondWith(206);
    const stream = await rangedStore().getStream("clip.mp4", {
      range: { end: 3, start: 0 },
    });
    expect(headers).toEqual(["bytes=0-3"]);
    expect(await new Response(stream).text()).toBe("part");
  });

  test("refuses a whole file sent in answer to a range", async () => {
    respondWith(200);
    await expect(
      rangedStore().getStream("clip.mp4", { range: { end: 3, start: 0 } }),
    ).rejects.toThrow("ignored the requested byte range");
  });
});
