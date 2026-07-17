import { UTApi, UTFile } from "uploadthing/server";
import {
  BlobError,
  collectBody,
  validateKey,
  type BlobObject,
  type BlobStore,
  type ListOptions,
  type PutOptions,
} from "./index";

const DEFAULT_LIST_LIMIT = 500;

type UploadThingFile = {
  customId: string | null;
  key: string;
  name: string;
  size: number;
  status: string;
  uploadedAt: number;
};

export type UploadThingClient = {
  deleteFiles: (
    keys: string[] | string,
    options?: { keyType?: "customId" | "fileKey" },
  ) => Promise<{ deletedCount: number; success: boolean }>;
  generateSignedURL: (
    key: string,
    options?: { expiresIn?: number },
  ) => Promise<{ ufsUrl: string }>;
  listFiles: (options?: {
    limit?: number;
    offset?: number;
  }) => Promise<{ files: readonly UploadThingFile[]; hasMore: boolean }>;
  uploadFiles: (
    file: UTFile,
    options?: { contentDisposition?: "inline" | "attachment" },
  ) => Promise<{
    data: null | {
      customId: string | null;
      fileHash: string;
      key: string;
      name: string;
      size: number;
      type: string;
    };
    error: null | { message: string };
  }>;
};

export type UploadThingBlobStoreOptions = {
  api?: UploadThingClient;
  label?: string;
  token?: string;
};

const objectFor = (file: UploadThingFile): BlobObject => ({
  key: file.customId ?? file.key,
  lastModified: file.uploadedAt,
  size: file.size,
});

export const uploadThingBlobStore = (
  options: UploadThingBlobStoreOptions = {},
): BlobStore => {
  const api =
    options.api ??
    (new UTApi({
      defaultKeyType: "customId",
      ...(options.token ? { token: options.token } : {}),
    }) as UploadThingClient);
  const list = async (listOptions: ListOptions = {}) => {
    const offset = listOptions.cursor ? Number(listOptions.cursor) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new BlobError("invalid UploadThing cursor", "INVALID_KEY");
    const limit = listOptions.limit ?? DEFAULT_LIST_LIMIT;
    const page = await api.listFiles({ limit, offset });
    const objects = page.files
      .filter(
        (file) =>
          file.status === "Uploaded" &&
          file.customId !== null &&
          file.customId.startsWith(listOptions.prefix ?? ""),
      )
      .map(objectFor);

    return {
      ...(page.hasMore ? { cursor: String(offset + page.files.length) } : {}),
      objects,
      truncated: page.hasMore,
    };
  };
  const head = async (key: string) => {
    validateKey(key);
    let cursor: string | undefined;
    do {
      const page = await list({ cursor, prefix: key });
      const found = page.objects.find((object) => object.key === key);
      if (found) return found;
      cursor = page.cursor;
    } while (cursor);

    return null;
  };

  return {
    delete: async (key) => {
      validateKey(key);
      await api.deleteFiles(key, { keyType: "customId" });
    },
    description: options.label ?? "UploadThing",
    get: async (key) => {
      validateKey(key);
      if (!(await head(key))) return null;
      const { ufsUrl } = await api.generateSignedURL(key);
      const response = await fetch(ufsUrl);
      if (!response.ok)
        throw new BlobError("UploadThing download failed", "PROVIDER_ERROR");

      return new Uint8Array(await response.arrayBuffer());
    },
    getStream: async (key) => {
      validateKey(key);
      if (!(await head(key))) return null;
      const { ufsUrl } = await api.generateSignedURL(key);
      const response = await fetch(ufsUrl);
      if (!response.ok || !response.body)
        throw new BlobError("UploadThing download failed", "PROVIDER_ERROR");

      return response.body;
    },
    head,
    list,
    presign: async (key, presignOptions = {}) => {
      validateKey(key);
      if (presignOptions.operation === "put")
        throw new BlobError(
          "UploadThing direct uploads use its file-route protocol",
          "UNSUPPORTED",
        );
      const { ufsUrl } = await api.generateSignedURL(key, {
        expiresIn: presignOptions.ttlSeconds,
      });

      return ufsUrl;
    },
    put: async (key, body, putOptions: PutOptions = {}) => {
      validateKey(key);
      const bytes = await collectBody(body);
      if (
        putOptions.maxBytes !== undefined &&
        bytes.byteLength > putOptions.maxBytes
      )
        throw new BlobError(
          "blob exceeds configured byte limit",
          "PROVIDER_ERROR",
        );
      const uploadBody = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(uploadBody).set(bytes);
      const result = await api.uploadFiles(
        new UTFile([uploadBody], key.split("/").at(-1) ?? key, {
          customId: key,
          type: putOptions.contentType,
        }),
        {
          contentDisposition: putOptions.contentDisposition?.startsWith(
            "attachment",
          )
            ? "attachment"
            : "inline",
        },
      );
      if (!result.data)
        throw new BlobError(
          result.error?.message ?? "UploadThing upload failed",
          "PROVIDER_ERROR",
        );

      return {
        contentType: result.data.type,
        etag: result.data.fileHash,
        key,
        size: result.data.size,
      };
    },
  };
};
