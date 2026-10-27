import type { SelectedFile } from "./preview";

const MAX_FILE = 64 * 1024 * 1024;
const MAX_TOTAL = 512 * 1024 * 1024;
export type DuplicateResult = { groups: string[][]; compared: number; skipped: number; failed: number; empty: number };

/** Same-size candidates only. Web Crypto requires an in-memory buffer, so work is bounded. */
export async function findDuplicates(files: SelectedFile[], signal: AbortSignal,
  onProgress: (done: number, total: number) => void): Promise<DuplicateResult> {
  const sizes = new Map<number, SelectedFile[]>();
  let empty = 0;
  for (const item of files) {
    if (item.size === 0) { empty++; continue; }
    const group = sizes.get(item.size);
    if (group) group.push(item);
    else sizes.set(item.size, [item]);
  }
  const candidates = [...sizes.values()].filter((group) => group.length > 1).flat();
  const hashes = new Map<string, string[]>();
  let compared = 0, skipped = 0, failed = 0, bytes = 0, done = 0;
  for (const item of candidates) {
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    if (item.size > MAX_FILE || bytes + item.size > MAX_TOTAL) skipped++;
    else {
      bytes += item.size;
      try {
        const buffer = await item.file.arrayBuffer();
        if (buffer.byteLength !== item.size) throw new Error("File size changed");
        const digest = await crypto.subtle.digest("SHA-256", buffer);
        if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
        const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
        const hashKey = `${item.size}:${hex}`;
        const group = hashes.get(hashKey);
        if (group) group.push(item.path);
        else hashes.set(hashKey, [item.path]);
        compared++;
      } catch (error) {
        if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
        failed++;
      }
    }
    onProgress(++done, candidates.length);
  }
  return { groups: [...hashes.values()].filter((group) => group.length > 1), compared, skipped, failed, empty };
}
