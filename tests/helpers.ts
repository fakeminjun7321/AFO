import type { TestContext } from 'node:test';
import type { ScanResult } from '../packages/contracts/src/index.js';
import { createFixture, createManifest } from './fixtures/index.js';
import type { FixtureSpec, Manifest } from './fixtures/index.js';

export { createFixture, createManifest, diffManifest, sameManifest, sampleSpec } from './fixtures/index.js';
export type { FixtureSpec, Manifest, ManifestDiff, ManifestEntry } from './fixtures/index.js';

/** Compatible wrapper: temp fixture removed after the test. */
export async function fixture(t: TestContext, files: FixtureSpec = {}): Promise<string> {
  return (await createFixture(files, t)).root;
}
export const manifest = (root: string): Promise<Manifest> => createManifest(root);

export function scanFixture(names: string[]): ScanResult {
  return { root: { id: 'a'.repeat(64), canonicalPath: '/afo-fixture', readOnly: true },
    files: names.map((relativePath, index) => ({ id: index.toString(16).padStart(64, '0'), relativePath,
      size: 20, modifiedNs: '100000', device: '1', inode: String(index + 1), sha256: null })),
    directories: [], skipped: [], complete: true };
}
