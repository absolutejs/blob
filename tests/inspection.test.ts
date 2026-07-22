import { describe, expect, test } from "bun:test";
import { localBlobStore } from "../src/local";
import {
  inspectStoredBlob,
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
