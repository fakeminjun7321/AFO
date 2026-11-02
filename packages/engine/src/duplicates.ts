import { AfoError, PreviewSchema, RelativePathSchema } from '../../contracts/src/index.js';
import type { Duplicate, DuplicateNote, FileSnapshot, Preview, SkippedEntry, SpaceEstimate } from '../../contracts/src/index.js';
import { compare, digest, pathKey } from './util.js';

export const SPACE_NOTE = '추정치입니다. 휴지통 이동은 공간을 확보하지 않으며 APFS 복제·스냅샷·압축 때문에 실제 확보량은 다를 수 있습니다.';
const PROTECTED_KEEP = '참고한 기존 파일을 남깁니다.';
const DEFAULT_KEEP = '사본 표시(" (1)", " copy", " 사본" 등)가 없고 더 얕은 위치·짧은 이름의 파일을 기본으로 남깁니다. 남길 파일은 바꿀 수 있습니다.';
const USER_KEEP = '사용자가 남길 파일을 지정했습니다.';
type Member = NonNullable<Duplicate['members']>[number];

/**
 * Copy marks that browsers, Finder and Explorer add before the extension: "a (1)"–"a (99)", "a copy", "a copy 2", "a_copy", "a-copy",
 * "a 사본", "a 사본 2", "a 복사본", "a복사본", "a - 복사본", "a - 복사본 (2)". Case and Unicode form (NFC) are ignored.
 */
const COPY_MARK = /^.+?(?: \([1-9]\d?\)| copy(?: \d+)?|[_-]copy(?:[ _-]?\d+)?| - 복사본(?: \([1-9]\d?\))?| ?복사본(?: \d+)?| 사본(?: \d+)?)$/u;
export function hasCopyMark(relativePath: string): boolean {
  const name = (relativePath.split('/').at(-1) ?? '').normalize('NFC').toLowerCase();
  const last = name.lastIndexOf('.'); const first = name.indexOf('.');
  // Both the stem before the last extension and before the first one: "v1.2 (1).pdf" and "archive (1).tar.gz".
  return [last > 0 ? name.slice(0, last) : name, first > 0 ? name.slice(0, first) : name].some((stem) => COPY_MARK.test(stem));
}
/** Default keeper order: protected → no copy mark → shallower path → shorter name → path order. Deterministic for the same paths. */
function keeperOrder(a: { path: string; protected: boolean }, b: { path: string; protected: boolean }): number {
  const depth = (p: string): number => p.split('/').length;
  const nameLength = (p: string): number => [...(p.split('/').at(-1) ?? '')].length;
  return Number(b.protected) - Number(a.protected) || Number(hasCopyMark(a.path)) - Number(hasCopyMark(b.path)) ||
    depth(a.path) - depth(b.path) || nameLength(a.path) - nameLength(b.path) || compare(a.path, b.path);
}

function withTotals(group: Omit<Duplicate, 'logicalCandidateBytes' | 'allocatedCandidateBytes' | 'reclaimableEstimateBytes'> &
  { size: number; members: Member[] }): Duplicate {
  const chosen = group.candidates.map((c) => group.members.find((m) => m.relativePath === c)!);
  const known = chosen.every((m) => m.allocatedBytes !== null);
  return { ...group, logicalCandidateBytes: chosen.length * group.size,
    allocatedCandidateBytes: known ? chosen.reduce((sum, m) => sum + m.allocatedBytes!, 0) : null,
    // Hard links never reach here (the scanner excludes nlink > 1) and protected files are never candidates.
    reclaimableEstimateBytes: chosen.reduce((sum, m) => sum + (m.allocatedBytes ?? group.size), 0) };
}

export function spaceEstimate(groups: Duplicate[]): SpaceEstimate {
  const allocated = groups.map((g) => g.allocatedCandidateBytes ?? null);
  return { logicalCandidateBytes: groups.reduce((sum, g) => sum + g.logicalCandidateBytes, 0),
    allocatedCandidateBytes: allocated.every((x) => x !== null) ? allocated.reduce((sum, x) => sum + x, 0) : null,
    reclaimableEstimateBytes: groups.reduce((sum, g) => sum + (g.reclaimableEstimateBytes ?? g.logicalCandidateBytes), 0),
    note: SPACE_NOTE };
}

/**
 * Content duplicates from hashed snapshots: equal size AND equal SHA-256. Names, age and size alone never qualify.
 * Empty files are never candidates. Protected (reference) files are kept and never become candidates.
 */
export function findDuplicates(files: FileSnapshot[], protectedKeys: ReadonlySet<string>, skipped: SkippedEntry[] = []):
  { duplicates: Duplicate[]; notes: DuplicateNote[] } {
  const notes: DuplicateNote[] = [];
  const empty = files.filter((f) => f.size === 0);
  if (empty.length > 1) for (const f of empty) notes.push({ relativePath: f.relativePath, code: 'EMPTY_FILE',
    reason: '빈 파일(0 B)은 내용이 같아도 중복 삭제 후보로 만들지 않습니다.' });
  const failed = new Set(skipped.filter((s) => s.code === 'HASH_FAILED' || s.code === 'FILE_CHANGED').map((s) => s.relativePath));
  for (const f of files) if (failed.has(f.relativePath)) notes.push({ relativePath: f.relativePath, code: 'HASH_UNAVAILABLE',
    reason: '내용을 확인하지 못해 중복 여부를 판단하지 않았습니다.' });
  const groups = new Map<string, FileSnapshot[]>();
  for (const f of files) if (f.size > 0 && f.sha256 !== null && !failed.has(f.relativePath)) {
    const key = `${f.size}:${f.sha256}`;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  const duplicates = [...groups.values()].filter((g) => g.length > 1).map((g) => {
    const isProtected = (f: FileSnapshot): boolean => protectedKeys.has(pathKey(f.relativePath));
    g.sort((a, b) => Number(isProtected(b)) - Number(isProtected(a)) || compare(a.relativePath, b.relativePath));
    const members: Member[] = g.map((f) => ({ relativePath: f.relativePath, allocatedBytes: f.allocatedBytes ?? null,
      protected: isProtected(f) }));
    // members stay in path order (protected first); the keeper is chosen by keeperOrder.
    const keep = [...members].sort((a, b) => keeperOrder({ path: a.relativePath, protected: a.protected },
      { path: b.relativePath, protected: b.protected }))[0]!;
    return withTotals({ sha256: g[0]!.sha256!, suggestedKeep: keep.relativePath, size: g[0]!.size, members,
      candidates: members.filter((m) => m !== keep && !m.protected).map((m) => m.relativePath),
      keepReason: keep.protected ? PROTECTED_KEEP : DEFAULT_KEEP });
  }).filter((g) => g.candidates.length > 0).sort((a, b) => compare(a.sha256, b.sha256));
  notes.sort((a, b) => compare(a.relativePath, b.relativePath) || compare(a.code, b.code));
  return { duplicates, notes };
}

const invalid = (message: string): AfoError => new AfoError('KEEPER_INVALID', message);

/**
 * Pure: returns a new preview where `keepPath` is kept for the group `sha256`.
 * `candidates` (default: every other unprotected member) must be members, not the keeper and not protected.
 * The input preview is not modified. This changes a proposal only and never authorizes deletion.
 */
export function chooseKeeper(input: unknown, sha256: string, keepPath: string, options: { candidates?: string[] } = {}): Preview {
  const preview = PreviewSchema.parse(input);
  const index = preview.duplicates.findIndex((g) => g.sha256 === sha256);
  const group = preview.duplicates[index];
  if (!group) throw invalid('해당 내용의 중복 그룹이 없습니다.');
  if (!group.members || group.size === undefined) throw invalid('그룹 구성 정보가 없는 미리보기입니다. 다시 분석하세요.');
  const members = group.members;
  const protectedItems = new Set(preview.items.filter((i) => i.reasonCode === 'PROTECTED_REFERENCE').map((i) => pathKey(i.source)));
  const member = (p: string): Member | undefined => members.find((m) => m.relativePath === p);
  const keep = member(RelativePathSchema.parse(keepPath));
  if (!keep) throw invalid('남길 파일은 같은 중복 그룹 안의 파일이어야 합니다.');
  const requested = options.candidates ?? members.filter((m) => m !== keep && !m.protected).map((m) => m.relativePath);
  if (new Set(requested).size !== requested.length) throw invalid('후보가 중복됩니다.');
  for (const c of requested) {
    const m = member(c);
    if (!m) throw invalid('중복 그룹 밖의 파일은 후보가 될 수 없습니다.');
    if (m === keep) throw invalid('남길 파일은 후보가 될 수 없습니다.');
    if (m.protected || protectedItems.has(pathKey(c))) throw invalid('참고한 기존 파일(보호 파일)은 후보가 될 수 없습니다.');
  }
  const candidates = [...requested].sort(compare);
  const changed = withTotals({ sha256: group.sha256, suggestedKeep: keep.relativePath, size: group.size, members, candidates,
    keepReason: keep.protected ? PROTECTED_KEEP : USER_KEEP });
  const duplicates = preview.duplicates.map((g, i) => i === index ? changed : g);
  const id = digest(JSON.stringify({ base: preview.id, duplicates }));
  return PreviewSchema.parse({ ...preview, id, duplicates, space: spaceEstimate(duplicates) });
}
