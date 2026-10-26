// 하네스 정책 단위 테스트: 역할별 편집 범위와 셸 명령 차단 규칙.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globToRegExp, decideEdit, decideBash, toRel, diffSnapshots } from '../lib/core.mjs';

const task = {
  id: 'E-2',
  allowedPaths: ['packages/core/src/features/**'],
  protectedPaths: ['tests/integration/executor/**'],
};

test('glob: **, *, ? 처리', () => {
  assert.ok(globToRegExp('packages/core/src/features/**').test('packages/core/src/features/a/b.ts'));
  assert.ok(!globToRegExp('packages/core/src/features/**').test('packages/core/src/rules/a.ts'));
  assert.ok(globToRegExp('**/CLAUDE.md').test('CLAUDE.md'));
  assert.ok(globToRegExp('**/CLAUDE.md').test('packages/core/CLAUDE.md'));
  assert.ok(globToRegExp('tsconfig*.json').test('tsconfig.base.json'));
  assert.ok(!globToRegExp('packages/*/package.json').test('packages/a/b/package.json'));
  assert.ok(globToRegExp('file?.txt').test('file1.txt'));
});

test('toRel: 프로젝트 밖은 null, 구분자는 /', () => {
  assert.equal(toRel('/proj/a/b.ts', '/proj'), 'a/b.ts');
  assert.equal(toRel('/other/x', '/proj'), null);
  assert.equal(toRel('/proj/../proj2/x', '/proj'), null);
});

const d = (role, rel, t = task) => decideEdit({ role, rel, task: t }).decision;

test('coordinator(주 세션): 문서·하네스는 허용, 구현·테스트는 확인 요청', () => {
  assert.equal(d('main', 'docs/status/tasks.json'), 'allow');
  assert.equal(d('main', '.claude/settings.json'), 'allow');
  assert.equal(d('main', 'packages/core/src/x.ts'), 'ask');
  assert.equal(d('main', 'tests/unit/a.test.mjs'), 'ask');
  assert.equal(d('main', null), 'ask');
});

test('developer: 허용 경로와 tests/만, 리뷰 테스트·상태·하네스·보호 경로는 거부', () => {
  assert.equal(d('core-builder', 'packages/core/src/features/tokenize.ts'), 'allow');
  assert.equal(d('core-builder', 'tests/unit/core/features.test.mjs'), 'allow');
  assert.equal(d('core-builder', 'packages/core/src/rules/engine.ts'), 'deny');
  assert.equal(d('core-builder', 'tests/review/E-2/edge.test.mjs'), 'deny');
  assert.equal(d('core-builder', 'docs/status/tasks.json'), 'deny');
  assert.equal(d('core-builder', 'docs/reviews/E-2-r1.md'), 'deny');
  assert.equal(d('core-builder', '.claude/agents/developer.md'), 'deny');
  assert.equal(d('core-builder', 'scripts/harness/lib/core.mjs'), 'deny');
  assert.equal(d('core-builder', 'AGENTS.md'), 'deny');
  assert.equal(d('core-builder', 'packages/core/CLAUDE.md'), 'deny');
  assert.equal(d('core-builder', 'tests/integration/executor/fi.test.mjs'), 'deny');
  assert.equal(d('core-builder', null), 'deny');
  assert.equal(d('core-builder', 'packages/core/src/features/x.ts', null), 'deny', '활성 과업이 없으면 거부');
});

test('reviewer: 보고서와 현재 과업의 리뷰 테스트만', () => {
  assert.equal(d('verifier', 'docs/reviews/E-2-r1.md'), 'allow');
  assert.equal(d('verifier', 'tests/review/E-2/edge.test.mjs'), 'allow');
  assert.equal(d('verifier', 'tests/review/E-3/edge.test.mjs'), 'deny');
  assert.equal(d('verifier', 'packages/core/src/features/tokenize.ts'), 'deny');
  assert.equal(d('verifier', 'tests/unit/core/features.test.mjs'), 'deny');
  assert.equal(d('verifier', 'docs/status/tasks.json'), 'deny');
});

test('역할 일치: 과업 role과 다른 구현 담당은 거부, interface-builder는 자기 과업 경로만', () => {
  const cli = { id: 'CLI-1', role: 'interface-builder', allowedPaths: ['apps/cli/**'], protectedPaths: [] };
  assert.equal(d('interface-builder', 'apps/cli/src/main.ts', cli), 'allow');
  assert.equal(d('interface-builder', 'tests/cli/preview.test.ts', cli), 'allow');
  assert.equal(d('interface-builder', 'packages/engine/src/index.ts', cli), 'deny');
  assert.equal(d('core-builder', 'apps/cli/src/main.ts', cli), 'deny', 'role 불일치');
  assert.equal(d('interface-builder', 'packages/core/src/features/x.ts', { ...task, role: 'core-builder' }), 'deny', 'role 불일치');
  assert.equal(d('interface-builder', 'scripts/harness/lib/core.mjs', cli), 'deny');
});

test('그 밖의 에이전트와 .git·.env는 거부', () => {
  assert.equal(d('general-purpose', 'packages/core/src/features/x.ts'), 'deny');
  assert.equal(d('Explore', 'docs/notes.md'), 'deny');
  assert.equal(d('main', '.env'), 'deny');
  assert.equal(d('main', '.git/config'), 'deny');
});

const b = (role, command) => decideBash({ role, command }).decision;

test('셸: 실제 사용자 폴더 경로는 모든 역할에서 거부', () => {
  for (const cmd of [
    'ls ~/Desktop', 'cp a.txt ~/Downloads/', 'node x.mjs "$HOME/Documents"',
    'rm /Users/minjun/Downloads/a.pdf', 'dir C:\\Users\\minseo\\Documents',
    'ls /home/kim/Pictures', 'cat %USERPROFILE%\\Desktop\\a.txt', 'ls "~/Library/Mobile Documents"',
  ]) {
    assert.equal(b('main', cmd), 'deny', cmd);
    assert.equal(b('core-builder', cmd), 'deny', cmd);
  }
});

test('셸: 파괴적 명령과 강제 푸시 거부', () => {
  assert.equal(b('main', 'rm -rf /'), 'deny');
  assert.equal(b('main', 'rm -rf ~'), 'deny');
  assert.equal(b('core-builder', 'rm -fr $HOME'), 'deny');
  assert.equal(b('main', 'git push --force origin feat/x'), 'deny');
  assert.equal(b('main', 'git push -f'), 'deny');
});

test('셸: 병합·main 푸시는 PM에게 확인 요청, 서브에이전트는 거부', () => {
  assert.equal(b('main', 'gh pr merge 12 --squash'), 'ask');
  assert.equal(b('main', 'git push origin main'), 'ask');
  assert.equal(b('main', 'git push -u origin feat/e-2-features'), 'ask');
  assert.equal(b('core-builder', 'gh pr merge 12'), 'deny');
  assert.equal(b('verifier', 'git push origin feat/x'), 'deny');
});

test('셸: 서브에이전트의 git 쓰기·되돌리기 거부, 읽기는 허용', () => {
  for (const cmd of ['git commit -m x', 'git checkout -- src/a.ts', 'git restore src/a.ts', 'git stash', 'git reset --hard', 'git switch main']) {
    assert.equal(b('core-builder', cmd), 'deny', cmd);
    assert.equal(b('verifier', cmd), 'deny', cmd);
  }
  for (const cmd of ['git diff', 'git status --short', 'git log --oneline -5', 'git show HEAD~1:a.ts', 'node scripts/harness/run-checks.mjs']) {
    assert.equal(b('verifier', cmd), 'allow', cmd);
  }
});

test('셸: 평범한 명령과 한국어 커밋 메시지는 허용(오탐 없음)', () => {
  assert.equal(b('main', 'git commit -m "E-2: 다운로드 폴더 정리 규칙 표"'), 'allow');
  assert.equal(b('main', 'node --test tests/unit/a.test.mjs'), 'allow');
  assert.equal(b('core-builder', 'mkdir -p "$TMPDIR/afo-test-1" && rm -rf "$TMPDIR/afo-test-1"'), 'allow');
});

test('스냅샷 비교: 추가·삭제·변경 구분', () => {
  const ch = diffSnapshots({ a: '1', b: '2', c: '3' }, { a: '1', b: '9', d: '4' });
  assert.deepEqual(ch, [
    { path: 'b', kind: 'modified' },
    { path: 'c', kind: 'removed' },
    { path: 'd', kind: 'added' },
  ]);
});
