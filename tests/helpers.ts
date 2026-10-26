import { mkdtemp, mkdir, writeFile, readdir, lstat, readFile, readlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { TestContext } from 'node:test';
import type { ScanResult } from '../packages/contracts/src/index.js';

export async function fixture(t: TestContext, files: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'afo-test-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  for (const [name, data] of Object.entries(files)) {
    const file = path.join(root, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data);
  }
  return root;
}

/** Independent oracle: includes hidden/excluded files; never follows symlinks. */
export async function manifest(root: string): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  async function visit(folder: string, prefix: string): Promise<void> {
    for (const name of (await readdir(folder)).sort()) {
      const full = path.join(folder, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = await lstat(full, { bigint: true });
      if (stat.isSymbolicLink()) result[relative] = { type: 'link', target: await readlink(full) };
      else if (stat.isDirectory()) { result[relative] = { type: 'directory' }; await visit(full, relative); }
      else result[relative] = { type: 'file', bytes: String(stat.size), modified: String(stat.mtimeNs),
        sha256: createHash('sha256').update(await readFile(full)).digest('hex') };
    }
  }
  await visit(root, '');
  return result;
}

export function scanFixture(names: string[]): ScanResult {
  return { root: { id: 'a'.repeat(64), canonicalPath: '/afo-fixture', readOnly: true },
    files: names.map((relativePath, index) => ({ id: index.toString(16).padStart(64, '0'), relativePath,
      size: 20, modifiedNs: '100000', device: '1', inode: String(index + 1), sha256: null })),
    directories: [], skipped: [], complete: true };
}
