import { Unzip, UnzipInflate } from "fflate";

const MAX_EXPANDED = 25 * 1024 * 1024;
const MAX_ENTRIES = 1000;
const MAX_DEPTH = 4;
const INPUT_CHUNK = 4096;
export const isZip = (bytes: Uint8Array) =>
  bytes.length >= 4 &&
  bytes[0] === 80 &&
  bytes[1] === 75 &&
  ((bytes[2] === 3 && bytes[3] === 4) || (bytes[2] === 5 && bytes[3] === 6));

/** ClamAV can report OK after skipping oversized ZIP entries (upstream #633).
 * Bound actual inflation independently, including nested Office/ZIP containers.
 * Never extract to disk or trust filenames, metadata sizes, or compression ratios. */
export function assertBoundedZip(bytes: Uint8Array) {
  let total = 0,
    count = 0;
  const inspect = (archive: Uint8Array, depth: number) => {
    if (!isZip(archive)) return;
    if (depth > MAX_DEPTH) throw Error("Archive nesting exceeds policy");
    const view = new DataView(
      archive.buffer,
      archive.byteOffset,
      archive.byteLength,
    );
    let footer = -1;
    for (
      let i = archive.length - 22;
      i >= Math.max(0, archive.length - 65557);
      i--
    ) {
      if (
        view.getUint32(i, true) === 0x06054b50 &&
        i + 22 + view.getUint16(i + 20, true) === archive.length
      ) {
        footer = i;
        break;
      }
    }
    if (footer < 0 || view.getUint32(footer + 4, true) !== 0)
      throw Error("Incomplete or multi-volume archive");
    const expected = view.getUint16(footer + 10, true);
    if (expected > MAX_ENTRIES) throw Error("Archive entry limit exceeded");
    let opened = 0,
      completed = 0;
    const unzip = new Unzip((file) => {
      if (
        ++count > MAX_ENTRIES ||
        (file.originalSize ?? 0) > MAX_EXPANDED - total
      )
        throw Error("Archive expansion exceeds policy");
      opened++;
      let length = 0;
      const chunks: Uint8Array[] = [];
      file.ondata = (error, chunk, final) => {
        if (error) throw error;
        total += chunk.length;
        length += chunk.length;
        if (total > MAX_EXPANDED) {
          file.terminate();
          throw Error("Archive expansion exceeds policy");
        }
        chunks.push(chunk);
        if (final) {
          completed++;
          const child = new Uint8Array(length);
          let offset = 0;
          for (const part of chunks) {
            child.set(part, offset);
            offset += part.length;
          }
          inspect(child, depth + 1);
        }
      };
      file.start();
    });
    unzip.register(UnzipInflate);
    for (let offset = 0; offset < archive.length; offset += INPUT_CHUNK)
      unzip.push(
        archive.subarray(offset, offset + INPUT_CHUNK),
        offset + INPUT_CHUNK >= archive.length,
      );
    if (opened !== expected || completed !== opened)
      throw Error("Incomplete archive contents");
  };
  inspect(bytes, 0);
}
