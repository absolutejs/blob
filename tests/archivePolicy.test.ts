import { expect, test } from "bun:test";
import { zipSync } from "fflate";
import { assertBoundedZip } from "../src/archivePolicy";

test("ordinary and nested ZIP/Office containers are allowed", () => {
  const inner = zipSync({
    "document.xml": new TextEncoder().encode("<document>safe</document>"),
  });
  expect(() => assertBoundedZip(inner)).not.toThrow();
  expect(() =>
    assertBoundedZip(zipSync({ "nested.zip": inner })),
  ).not.toThrow();
});
test("oversized ZIP entries are blocked even with forged local size metadata", () => {
  const archive = zipSync({ "large.txt": new Uint8Array(26 * 1024 * 1024) });
  expect(() => assertBoundedZip(archive)).toThrow();
  new DataView(archive.buffer).setUint32(22, 1, true);
  expect(() => assertBoundedZip(archive)).toThrow();
});
test("truncation, entry count and nested recursion are bounded", () => {
  let archive = zipSync({ "case.txt": new Uint8Array([1]) });
  expect(() =>
    assertBoundedZip(archive.subarray(0, archive.length - 10)),
  ).toThrow();
  for (let i = 0; i < 6; i++) archive = zipSync({ "nested.zip": archive });
  expect(() => assertBoundedZip(archive)).toThrow();
  const files = Object.fromEntries(
    Array.from({ length: 1001 }, (_, i) => [`${i}.txt`, new Uint8Array()]),
  );
  expect(() => assertBoundedZip(zipSync(files))).toThrow();
});
