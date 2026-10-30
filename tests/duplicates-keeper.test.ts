import test from 'node:test';
import assert from 'node:assert/strict';
import type { FileSnapshot } from '../packages/contracts/src/index.js';
import { findDuplicates, hasCopyMark } from '../packages/engine/src/index.js';

/* Default keeper of a duplicate group: protected → no copy mark → shallower → shorter name → path order. Pure, synthetic snapshots. */
const H = 'a'.repeat(64);
const snap = (relativePath: string, i: number): FileSnapshot => ({ id: (i + 1).toString(16).padStart(64, '0'), relativePath, size: 10,
  modifiedNs: '1', device: '1', inode: String(i + 1), sha256: H });
const keeper = (paths: string[], protectedPaths: string[] = []): { keep: string; candidates: string[] } => {
  const { duplicates } = findDuplicates(paths.map(snap), new Set(protectedPaths.map((p) => p.normalize('NFC').toLowerCase())));
  assert.equal(duplicates.length, 1);
  return { keep: duplicates[0]!.suggestedKeep, candidates: duplicates[0]!.candidates };
};

test('copy marks before the extension are recognised (browser, Finder, Explorer; case and NFC ignored)', () => {
  for (const name of ['보고서 (1).pdf', '보고서 (99).pdf', 'a copy.pdf', 'a copy 2.pdf', 'A COPY.PDF', 'a_copy.txt', 'a-copy.txt',
    '사진 사본.jpg', '사진 사본 2.jpg', '사진 복사본.jpg', '사진복사본.jpg', '보고서 - 복사본.pdf', '보고서 - 복사본 (2).pdf',
    '사진 사본.jpg'.normalize('NFD'), 'dir/보고서 (1).pdf', 'archive (1).tar.gz', 'v1.2 (1).pdf', 'notes (3)'])
    assert.equal(hasCopyMark(name), true, name);
  for (const name of ['보고서.pdf', 'copy.pdf', '복사본.pdf', 'a (0).pdf', 'a (100).pdf', 'a(1).pdf', 'photocopy.pdf', 'a copyright.pdf',
    'a (1)/b.pdf', '사본들.pdf'])
    assert.equal(hasCopyMark(name), false, name);
});

test('the file without a copy mark is kept, whatever the path order', () => {
  assert.deepEqual(keeper(['보고서.pdf', '보고서 (1).pdf']), { keep: '보고서.pdf', candidates: ['보고서 (1).pdf'] });
  assert.deepEqual(keeper(['report copy.pdf', 'report.pdf']), { keep: 'report.pdf', candidates: ['report copy.pdf'] });
  assert.deepEqual(keeper(['사진 - 복사본.jpg', '사진.jpg', '사진 (2).jpg']).keep, '사진.jpg');
  // A copy mark outweighs depth: the original deep in a folder beats a shallow copy.
  assert.deepEqual(keeper(['과제/물리/보고서.pdf', '보고서 (1).pdf']).keep, '과제/물리/보고서.pdf');
});

test('then shallower path, then shorter name, then path order; protected files always win', () => {
  assert.equal(keeper(['a/b/x.pdf', 'z.pdf']).keep, 'z.pdf');
  assert.equal(keeper(['long-name.pdf', 'b.pdf']).keep, 'b.pdf');
  assert.equal(keeper(['b.pdf', 'a.pdf']).keep, 'a.pdf');
  const p = keeper(['보고서.pdf', '참고/보고서 (1).pdf'], ['참고/보고서 (1).pdf']);
  assert.deepEqual(p, { keep: '참고/보고서 (1).pdf', candidates: ['보고서.pdf'] });
});

test('deterministic: the same files in any input order give the same keeper and candidates', () => {
  const files = ['다운로드 (2).pdf', 'x/다운로드.pdf', '다운로드 copy.pdf', '다운로드.pdf', 'y/z/다운로드.pdf'];
  const first = keeper(files);
  assert.equal(first.keep, '다운로드.pdf');
  for (let i = 0; i < 5; i++) assert.deepEqual(keeper([...files.slice(i), ...files.slice(0, i)].reverse()), first);
});
