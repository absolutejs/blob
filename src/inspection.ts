import type { BlobStore } from "./index";

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const CLAMD_CHUNK_BYTES = 64 * 1024;

export type BlobInspectionResult = {
  details?: string;
  scanner: string;
  signature?: string;
  verdict: "clean" | "infected" | "unavailable";
};

export type BlobInspectionInput = {
  contentType?: string;
  filename: string;
  maxBytes?: number;
  size: number;
  stream: ReadableStream<Uint8Array>;
};

export type BlobInspector = {
  readonly description: string;
  inspect(input: BlobInspectionInput): Promise<BlobInspectionResult>;
};

export class BlobInspectionError extends Error {
  constructor(
    message: string,
    readonly code: "MISSING" | "TOO_LARGE",
  ) {
    super(message);
    this.name = "BlobInspectionError";
  }
}

export const inspectStoredBlob = async (
  store: BlobStore,
  inspector: BlobInspector,
  input: { filename: string; key: string; maxBytes?: number },
) => {
  const metadata = await store.head(input.key);
  if (!metadata)
    throw new BlobInspectionError("Stored blob is missing", "MISSING");
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
  if (metadata.size > maxBytes)
    throw new BlobInspectionError(
      "Stored blob exceeds the inspection byte limit",
      "TOO_LARGE",
    );
  const stream = await store.getStream(input.key);
  if (!stream)
    throw new BlobInspectionError("Stored blob is missing", "MISSING");

  return inspector.inspect({
    contentType: metadata.contentType,
    filename: input.filename,
    maxBytes,
    size: metadata.size,
    stream,
  });
};

export const parseClamdResponse = (response: string): BlobInspectionResult => {
  const normalized = response.replaceAll("\0", "").trim();
  if (normalized.endsWith(" OK")) return { scanner: "clamd", verdict: "clean" };
  const found = normalized.match(/:\s+(.+)\s+FOUND$/);
  if (found?.[1])
    return {
      scanner: "clamd",
      signature: found[1],
      verdict: "infected",
    };

  return {
    details: normalized || "ClamAV returned an empty response",
    scanner: "clamd",
    verdict: "unavailable",
  };
};

const frame = (chunk: Uint8Array) => {
  const framed = new Uint8Array(chunk.length + 4);
  new DataView(framed.buffer).setUint32(0, chunk.length);
  framed.set(chunk, 4);

  return framed;
};

export const createClamdBlobInspector = (options: {
  host: string;
  maxBytes?: number;
  port?: number;
  timeoutMs?: number;
}): BlobInspector => ({
  description: `ClamAV clamd at ${options.host}:${options.port ?? 3310}`,
  inspect: async (input) => {
    const maxBytes = Math.min(
      input.maxBytes ?? DEFAULT_MAX_BYTES,
      options.maxBytes ?? DEFAULT_MAX_BYTES,
    );
    if (input.size > maxBytes)
      throw new BlobInspectionError(
        "Blob exceeds the ClamAV inspection byte limit",
        "TOO_LARGE",
      );

    return new Promise<BlobInspectionResult>((resolve) => {
      let settled = false;
      let response = "";
      const settle = (result: BlobInspectionResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const unavailable = (error: unknown) =>
        settle({
          details:
            error instanceof Error ? error.message : "ClamAV unavailable",
          scanner: "clamd",
          verdict: "unavailable",
        });
      const timer = setTimeout(
        () => unavailable(new Error("ClamAV inspection timed out")),
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );

      Bun.connect({
        hostname: options.host,
        port: options.port ?? 3310,
        socket: {
          close: () => settle(parseClamdResponse(response)),
          data: (_socket, data) => {
            response += new TextDecoder().decode(data);
            if (response.includes("\0")) settle(parseClamdResponse(response));
          },
          error: (_socket, error) => unavailable(error),
          open: async (socket) => {
            try {
              socket.write("zINSTREAM\0");
              const reader = input.stream.getReader();
              let received = 0;
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                if (!value) continue;
                received += value.length;
                if (received > maxBytes) {
                  socket.end();
                  throw new BlobInspectionError(
                    "Blob exceeds the ClamAV inspection byte limit",
                    "TOO_LARGE",
                  );
                }
                for (
                  let offset = 0;
                  offset < value.length;
                  offset += CLAMD_CHUNK_BYTES
                )
                  socket.write(
                    frame(value.subarray(offset, offset + CLAMD_CHUNK_BYTES)),
                  );
              }
              socket.write(new Uint8Array(4));
            } catch (error) {
              socket.end();
              unavailable(error);
            }
          },
        },
      }).catch(unavailable);
    });
  },
});
