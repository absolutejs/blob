import { assertBoundedZip, isZip } from "./archivePolicy";
import { createConnection, type Socket } from "node:net";
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
  signal?: AbortSignal;
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
  input: {
    filename: string;
    key: string;
    maxBytes?: number;
    signal?: AbortSignal;
  },
) => {
  input.signal?.throwIfAborted();
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

  try {
    return await inspector.inspect({
      contentType: metadata.contentType,
      filename: input.filename,
      maxBytes,
      size: metadata.size,
      stream,
      signal: input.signal,
    });
  } finally {
    if (!stream.locked) await stream.cancel().catch(() => {});
  }
};

export const parseClamdResponse = (response: string): BlobInspectionResult => {
  // Only accept one complete INSTREAM response, never a suffix of an error or a
  // truncated socket. Limit/heuristic findings are not a clean scan.
  const match = /^stream: (OK|([^\r\n\0]+) FOUND)\0$/.exec(response);
  if (match?.[1] === "OK") return { scanner: "clamd", verdict: "clean" };
  if (match?.[2])
    return { scanner: "clamd", verdict: "infected", signature: match[2] };
  return {
    scanner: "clamd",
    verdict: "unavailable",
    details: "Scanner returned an invalid or incomplete response",
  };
};

const frame = (chunk: Uint8Array) => {
  const framed = new Uint8Array(chunk.length + 4);
  new DataView(framed.buffer).setUint32(0, chunk.length);
  framed.set(chunk, 4);
  return framed;
};

export type ClamdInspectorOptions = {
  host: string;
  maxBytes?: number;
  port?: number;
  timeoutMs?: number;
};

export const createClamdBlobInspector = (
  options: ClamdInspectorOptions,
): BlobInspector => {
  if (
    !options.host ||
    !Number.isSafeInteger(options.port ?? 3310) ||
    (options.port ?? 3310) < 1 ||
    (options.port ?? 3310) > 65535 ||
    !Number.isSafeInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS) ||
    (options.timeoutMs ?? DEFAULT_TIMEOUT_MS) <= 0
  )
    throw new TypeError("Invalid ClamAV connection options");
  return {
    description: `ClamAV clamd at ${options.host}:${options.port ?? 3310}`,
    inspect: async (input) => {
      const maxBytes = Math.min(
        input.maxBytes ?? DEFAULT_MAX_BYTES,
        options.maxBytes ?? DEFAULT_MAX_BYTES,
      );
      if (
        !Number.isSafeInteger(maxBytes) ||
        maxBytes < 0 ||
        !Number.isSafeInteger(input.size) ||
        input.size < 0 ||
        input.size > maxBytes
      ) {
        await input.stream.cancel().catch(() => {});
        throw new BlobInspectionError(
          "Blob exceeds the ClamAV inspection byte limit",
          "TOO_LARGE",
        );
      }
      const reader = input.stream.getReader();
      return new Promise<BlobInspectionResult>((resolve) => {
        let prefix = new Uint8Array(0);
        let zipChunks: Uint8Array[] = [];
        let captureZip: boolean | undefined;
        let settled = false,
          response = "",
          sentAll = false,
          socket: Socket | undefined;
        const settle = (result: BlobInspectionResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          input.signal?.removeEventListener("abort", abort);
          socket?.destroy();
          void reader
            .cancel()
            .catch(() => {})
            .finally(() => {
              try {
                reader.releaseLock();
              } catch {}
            });
          resolve(result);
        };
        const unavailable = (details: string) =>
          settle({ scanner: "clamd", verdict: "unavailable", details });
        const abort = () => unavailable("Inspection cancelled");
        const timer = setTimeout(
          () => unavailable("ClamAV inspection timed out"),
          options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        );
        input.signal?.addEventListener("abort", abort, { once: true });
        if (input.signal?.aborted) {
          abort();
          return;
        }
        const write = (data: Uint8Array | string) =>
          new Promise<void>((done, reject) => {
            if (settled || !socket) {
              reject(new Error("Inspection closed"));
              return;
            }
            socket.write(data, (error) => (error ? reject(error) : done()));
          });
        try {
          socket = createConnection({
            host: options.host,
            port: options.port ?? 3310,
          });
        } catch {
          unavailable("Cannot connect to scanner");
          return;
        }
        socket.on("error", () => unavailable("Scanner connection failed"));
        socket.on("close", () => {
          if (!settled)
            unavailable("Scanner disconnected before a complete verdict");
        });
        socket.on("data", (data) => {
          if (settled) return;
          response += data.toString("utf8");
          if (response.length > 4096) {
            unavailable("Scanner response exceeded limit");
            return;
          }
          if (response.includes("\0")) {
            const verdict = parseClamdResponse(response);
            if (verdict.verdict === "clean" && !sentAll) {
              unavailable("Scanner replied before the full file was sent");
              return;
            }
            if (verdict.verdict === "clean" && captureZip) {
              try {
                const archive = new Uint8Array(input.size);
                let offset = 0;
                for (const part of zipChunks) {
                  archive.set(part, offset);
                  offset += part.length;
                }
                assertBoundedZip(archive);
              } catch {
                settle({
                  scanner: "clamd+archive-policy",
                  verdict: "infected",
                  signature: "Policy.ArchiveLimitsOrInvalid",
                });
                return;
              }
            }
            zipChunks = [];
            settle(verdict);
          }
        });
        socket.once("connect", () => {
          void (async () => {
            try {
              await write("zINSTREAM\0");
              let received = 0;
              while (!settled) {
                const { done, value } = await reader.read();
                if (settled) return;
                if (done) break;
                if (captureZip !== false) {
                  zipChunks.push(value);
                  if (captureZip === undefined) {
                    const combined = new Uint8Array(
                      Math.min(4, prefix.length + value.length),
                    );
                    combined.set(prefix);
                    combined.set(
                      value.subarray(0, combined.length - prefix.length),
                      prefix.length,
                    );
                    prefix = combined;
                    if (prefix.length === 4) {
                      captureZip = isZip(prefix);
                      if (!captureZip) zipChunks = [];
                    }
                  }
                }
                received += value.byteLength;
                if (received > maxBytes || received > input.size) {
                  unavailable("Upload exceeds the declared byte limit");
                  return;
                }
                for (
                  let offset = 0;
                  offset < value.byteLength;
                  offset += CLAMD_CHUNK_BYTES
                )
                  await write(
                    frame(value.subarray(offset, offset + CLAMD_CHUNK_BYTES)),
                  );
              }
              if (settled) return;
              if (received !== input.size) {
                unavailable("Upload ended before its declared size");
                return;
              }
              // Mark before writing the terminal frame, so a fast legitimate response
              // cannot race the socket write callback.
              sentAll = true;
              await write(new Uint8Array(4));
            } catch {
              if (!settled) unavailable("Cannot stream file to scanner");
            }
          })();
        });
      });
    },
  };
};

export type BlobInspectionJob = { resourceId: string; revision: string };
export type BlobInspectionTarget = {
  key: string;
  filename: string;
  maxBytes?: number;
};
export class BlobInspectionUnavailableError extends Error {
  constructor() {
    super("Blob inspection unavailable; retry without releasing the file");
    this.name = "BlobInspectionUnavailableError";
  }
}
/** Queue-compatible processor. The host loads and commits by immutable revision;
 * commit must compare that revision inside its resource transaction. */
export const createBlobInspectionProcessor =
  (options: {
    store: BlobStore;
    inspector: BlobInspector;
    load: (job: BlobInspectionJob) => Promise<BlobInspectionTarget | null>;
    commit: (
      job: BlobInspectionJob,
      result: BlobInspectionResult,
    ) => Promise<void>;
  }) =>
  async (job: BlobInspectionJob, signal?: AbortSignal) => {
    const target = await options.load(job);
    if (!target) return;
    let result: BlobInspectionResult;
    try {
      result = await inspectStoredBlob(options.store, options.inspector, {
        ...target,
        signal,
      });
    } catch {
      result = {
        scanner: options.inspector.description,
        verdict: "unavailable",
        details: "Could not inspect the stored object",
      };
    }
    if (signal?.aborted)
      result = {
        scanner: options.inspector.description,
        verdict: "unavailable",
        details: "Inspection cancelled",
      };
    await options.commit(job, result);
    if (result.verdict === "unavailable")
      throw new BlobInspectionUnavailableError();
  };
