import { describe, expect, test } from "bun:test";
import { localBlobStore } from "../src/local";
import {
  inspectStoredBlob,
  createClamdBlobInspector,
  createBlobInspectionProcessor,
  BlobInspectionUnavailableError,
  parseClamdResponse,
  type BlobInspector,
} from "../src/inspection";

describe("blob inspection", () => {
  test("normalizes clean, infected, and unavailable ClamAV responses", () => {
    expect(parseClamdResponse("stream: OK\0")).toEqual({
      scanner: "clamd",
      verdict: "clean",
    });
    expect(parseClamdResponse("stream: Win.Test.EICAR_HDB-1 FOUND\0")).toEqual({
      scanner: "clamd",
      signature: "Win.Test.EICAR_HDB-1",
      verdict: "infected",
    });
    expect(parseClamdResponse("stream: scan failed ERROR\0").verdict).toBe(
      "unavailable",
    );
  });

  test("inspects a bounded private object through the shared store contract", async () => {
    const root = `/tmp/absolutejs-blob-inspection-${crypto.randomUUID()}`;
    const store = localBlobStore({ root });
    await store.put("quarantine/case.txt", "safe evidence", {
      contentType: "text/plain",
    });
    const inspector: BlobInspector = {
      description: "test inspector",
      inspect: async (input) => ({
        details: `${input.filename}:${input.size}`,
        scanner: "test",
        verdict: "clean",
      }),
    };

    expect(
      await inspectStoredBlob(store, inspector, {
        filename: "case.txt",
        key: "quarantine/case.txt",
      }),
    ).toEqual({
      details: "case.txt:13",
      scanner: "test",
      verdict: "clean",
    });
  });
});

// Real TCP framing exercises the production transport without a daemon dependency.
import { createServer, type Socket } from "node:net";
async function daemon(run: (socket: Socket) => void) {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    run(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return {
    port: address.port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
const bytes = (value: string) => new Blob([value]).stream();

test("clamd transport sends bounded frames and waits for a complete verdict", async () => {
  const value = "hello".repeat(40000);
  let received = Buffer.alloc(0),
    started = false,
    count = 0,
    largest = 0;
  const server = await daemon((socket) =>
    socket.on("data", (chunk) => {
      received = Buffer.concat([received, Buffer.from(chunk)]);
      if (!started) {
        if (received.length < 10) return;
        expect(received.subarray(0, 10).toString()).toBe("zINSTREAM\0");
        received = received.subarray(10);
        started = true;
      }
      while (received.length >= 4) {
        const size = received.readUInt32BE(0);
        if (received.length < size + 4) return;
        received = received.subarray(size + 4);
        count += size;
        largest = Math.max(largest, size);
        if (size === 0) {
          socket.write("stream: O");
          setTimeout(() => socket.end("K\0"), 5);
        }
      }
    }),
  );
  try {
    expect(
      (
        await createClamdBlobInspector({
          host: "127.0.0.1",
          port: server.port,
        }).inspect({ filename: "a", size: value.length, stream: bytes(value) })
      ).verdict,
    ).toBe("clean");
    expect(count).toBe(value.length);
    expect(largest).toBeLessThanOrEqual(65536);
  } finally {
    await server.close();
  }
});

test("timeouts cancel stalled input and close the scanner connection", async () => {
  let cancelled = false;
  const server = await daemon(() => {});
  try {
    const result = await createClamdBlobInspector({
      host: "127.0.0.1",
      port: server.port,
      timeoutMs: 30,
    }).inspect({
      filename: "a",
      size: 1,
      stream: new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
    });
    expect(result.verdict).toBe("unavailable");
    await Bun.sleep(1);
    expect(cancelled).toBe(true);
  } finally {
    await server.close();
  }
});

test("incomplete, misleading, and multiple responses never become clean", () => {
  for (const response of [
    "stream: OK",
    "error OK\0",
    "stream: OK\0junk",
    "stream: OK\0stream: OK\0",
    "stream: size limit exceeded ERROR\0",
  ])
    expect(parseClamdResponse(response).verdict).toBe("unavailable");
});

test("early clean verdict and declared size mismatch fail closed", async () => {
  const server = await daemon((socket) =>
    socket.on("data", () => socket.end("stream: OK\0")),
  );
  try {
    expect(
      (
        await createClamdBlobInspector({
          host: "127.0.0.1",
          port: server.port,
        }).inspect({ filename: "a", size: 1, stream: new ReadableStream() })
      ).verdict,
    ).toBe("unavailable");
  } finally {
    await server.close();
  }
  const silent = await daemon(() => {});
  try {
    for (const size of [1, 3])
      expect(
        (
          await createClamdBlobInspector({
            host: "127.0.0.1",
            port: silent.port,
          }).inspect({ filename: "a", size, stream: bytes("ab") })
        ).verdict,
      ).toBe("unavailable");
  } finally {
    await silent.close();
  }
});

test("queue processor skips stale jobs and throws after committing unavailable verdict", async () => {
  const store = localBlobStore({
    root: `/tmp/blob-processor-${crypto.randomUUID()}`,
  });
  await store.put("a", "test");
  let commits = 0;
  const processor = createBlobInspectionProcessor({
    store,
    inspector: {
      description: "test",
      inspect: async () => ({ scanner: "test", verdict: "unavailable" }),
    },
    load: async (job) =>
      job.revision === "current" ? { filename: "a", key: "a" } : null,
    commit: async (_job, result) => {
      expect(result.verdict).toBe("unavailable");
      commits++;
    },
  });
  await processor({ resourceId: "a", revision: "stale" });
  expect(commits).toBe(0);
  await expect(
    processor({ resourceId: "a", revision: "current" }),
  ).rejects.toBeInstanceOf(BlobInspectionUnavailableError);
  expect(commits).toBe(1);
  await store.delete("a");
});

test('cancelled job cannot commit a clean result', async () => {
 const store = localBlobStore({root:`/tmp/blob-cancel-${crypto.randomUUID()}`});
 await store.put('a','test');
 const controller = new AbortController();
 const processor=createBlobInspectionProcessor({store,load:async()=>({key:'a',filename:'a'}),inspector:{description:'fixture',inspect:async()=>{controller.abort();return {scanner:'fixture',verdict:'clean'};}},commit:async(_job,result)=>{expect(result.verdict).toBe('unavailable');}});
 await expect(processor({resourceId:'a',revision:'1'},controller.signal)).rejects.toBeInstanceOf(BlobInspectionUnavailableError);
 await store.delete('a');
});
