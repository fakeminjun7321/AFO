import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';

/**
 * Synthetic fixtures only. Every tree is created under a fresh mkdtemp(os.tmpdir()) folder;
 * there is no option to target an existing (user) folder.
 * Spec keys are '/'-separated relative paths. A key ending in '/' is an empty directory.
 */
export type FixtureEntry = string | Uint8Array | { data: string | Uint8Array; modified?: Date };
export type FixtureSpec = Record<string, FixtureEntry>;
export interface Fixture { root: string; cleanup: () => Promise<void> }

export const FIXTURE_PREFIX = 'afo-test-';

/** Names that exercise Korean (NFC and NFD), spaces, emoji, empty files and nesting. */
export const sampleSpec = (): FixtureSpec => ({
  '보고서 최종.pdf': 'report', '사진/여행 😀.jpg': 'image', '사진/빈 파일.png': '',
  [`문서/${'한글'.normalize('NFD')}.txt`]: 'nfd name', '깊은/a/b/c/d.txt': 'nested',
  '같은 내용 1.zip': 'same bytes', '같은 내용 2.zip': 'same bytes', '빈 폴더/': '',
});

function resolveInside(root: string, relative: string): string {
  const parts = relative.replace(/\/$/u, '').split('/');
  if (relative.startsWith('/') || parts.some((part) => part === '' || part === '.' || part === '..' || /[\\:\u0000]/u.test(part)))
    throw new Error(`fixture 경로는 단순 상대 경로여야 합니다: ${JSON.stringify(relative)}`);
  return path.join(root, ...parts);
}

export async function createFixture(spec: FixtureSpec = {}, t?: TestContext): Promise<Fixture> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), FIXTURE_PREFIX)));
  const cleanup = async (): Promise<void> => { await rm(root, { recursive: true, force: true }); };
  t?.after(cleanup);
  try {
    for (const [relative, entry] of Object.entries(spec)) {
      const target = resolveInside(root, relative);
      if (relative.endsWith('/')) { await mkdir(target, { recursive: true }); continue; }
      await mkdir(path.dirname(target), { recursive: true });
      const { data, modified } = typeof entry === 'string' || entry instanceof Uint8Array ? { data: entry, modified: undefined } : entry;
      await writeFile(target, data, { flag: 'wx' });
      if (modified) await utimes(target, modified, modified);
    }
  } catch (error) { await cleanup(); throw error; }
  return { root, cleanup };
}

export type ManifestEntry =
  | { type: 'file'; bytes: string; modified: string; sha256: string }
  | { type: 'directory' }
  | { type: 'link'; target: string }
  | { type: 'other' };
export type Manifest = Record<string, ManifestEntry>;

/** Independent oracle: includes hidden/excluded names, never follows links, does not reuse product code. */
export async function createManifest(root: string): Promise<Manifest> {
  // Collect entries, then Object.fromEntries: names such as __proto__ or constructor become own keys of a plain object.
  const entries: [string, ManifestEntry][] = [];
  async function visit(folder: string, prefix: string): Promise<void> {
    for (const name of (await readdir(folder)).sort()) {
      const full = path.join(folder, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = await lstat(full, { bigint: true });
      if (stat.isSymbolicLink()) entries.push([relative, { type: 'link', target: await readlink(full) }]);
      else if (stat.isDirectory()) { entries.push([relative, { type: 'directory' }]); await visit(full, relative); }
      else if (stat.isFile()) entries.push([relative, { type: 'file', bytes: String(stat.size), modified: String(stat.mtimeNs),
        sha256: createHash('sha256').update(await readFile(full)).digest('hex') }]);
      else entries.push([relative, { type: 'other' }]);
    }
  }
  await visit(root, '');
  return Object.fromEntries(entries) as Manifest;
}

export interface ManifestDiff { added: string[]; removed: string[]; changed: string[] }
/** By default a changed mtime counts as a change; pass { ignoreModified: true } to compare content only. */
export function diffManifest(before: Manifest, after: Manifest, options: { ignoreModified?: boolean } = {}): ManifestDiff {
  const strip = (entry: ManifestEntry): string => JSON.stringify(options.ignoreModified && entry.type === 'file'
    ? { ...entry, modified: undefined } : entry);
  const sorted = (values: string[]): string[] => values.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  const removed = Object.keys(before).filter((name) => !Object.hasOwn(after, name));
  const added = Object.keys(after).filter((name) => !Object.hasOwn(before, name));
  const changed = Object.keys(before).filter((name) => Object.hasOwn(after, name) && strip(before[name]!) !== strip(after[name]!));
  return { added: sorted(added), removed: sorted(removed), changed: sorted(changed) };
}
export const sameManifest = (diff: ManifestDiff): boolean =>
  diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0;
