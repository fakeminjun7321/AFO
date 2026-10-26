# AFO 세션 하네스 — 역할 정의 (이 Code 세션 전용)

이 파일은 저장소 밖(세션 scratchpad)에 있습니다. 저장소의 `.claude/**`, `AGENTS.md`, `CLAUDE.md`, `docs/HARNESS.md`,
`scripts|tools/harness/**`는 **다른 Claude 채팅(PM 세션)이 구축 중**이므로 어떤 역할도 수정하지 않습니다.
역할 구성은 저장소의 docs/HARNESS.md 설계(coordinator / core-builder / interface-builder / verifier)를 따릅니다.

## 공통 규칙 (모든 역할)

- 저장소: `/Users/minjun/AFO` (GitHub `fakeminjun7321/AFO`). Node.js 24, npm, TypeScript 5.9.3 strict, Zod 4.6.7, `node --test`.
- 먼저 읽기: `AGENTS.md`, `docs/ARCHITECTURE.md`, `docs/INTERFACES.md`, `docs/VERIFICATION.md`, 담당 이슈(`gh issue view N`), 그리고 `DESIGN.md`(이 폴더).
- 의존성 추가 금지(package.json·package-lock.json 수정 금지). OS 기능은 Node 내장 API와 OS 기본 명령(`/usr/bin/trash`, PowerShell)만 사용.
- 실제 사용자 폴더(바탕화면·다운로드·홈·문서)를 대상으로 삼지 않음. 테스트는 `mkdtemp(os.tmpdir())`로 만든 합성 폴더와, 상태 저장은 `AFO_STATE_DIR`로 지정한 temp 폴더만 사용.
  - 예외: OS 휴지통 검사는 합성 temp 파일(`afo-test-` 접두)을 실제 휴지통으로 보낼 수 있음. 휴지통 비우기·휴지통 안 다른 항목 조작은 금지.
- 기존 코드 스타일을 따름: 짧고 밀도 높은 TypeScript, 한국어 사용자 메시지, 영어 코드 주석은 꼭 필요한 곳에만, `z.strictObject`.
- 실행하지 않은 검사를 통과로 보고하지 않음. mock 결과를 실제 OS 결과로 보고하지 않음. Windows는 이 Mac에서 검증할 수 없음 → "Windows: 미검증(CI 대기)"으로 표기.
- git: 맡은 worktree 브랜치에서만 커밋. push·PR·병합·이슈 수정은 하지 않음(coordinator가 함). 커밋 메시지는 한국어 `기능: …`/`검증: …` 형식, 끝에 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- 작업 시작 시 `git rev-parse HEAD`로 기준 SHA 기록. node_modules가 없으면 `npm ci --ignore-scripts --no-audit --no-fund`.
- 완료 전 반드시 `npm run typecheck && npm test` 실행, 실제 출력 요약을 반환.

## core-builder

- 쓰기 범위: 패킷의 Owned paths(주로 `packages/**`, 해당 `tests/*.test.ts`, 새 `docs/adr/*.md`, `docs/verification/*.md`).
- 하지 않는 일: CLI 출력 형식 변경(interface-builder 몫, 패킷에서 허용한 경우 제외), 계약 범위 밖 리팩터링, 승인 검사 생략.

## interface-builder

- 쓰기 범위: `apps/cli/**`, `tests/cli*.test.ts`, 새 `docs/CLI.md`.
- 하지 않는 일: 엔진·승인 정책을 CLI에 중복 구현, 엔진 우회해 직접 파일 쓰기, `--yes` 같은 불리언만으로 실행.

## verifier

- 쓰기 범위: `tests/verify-*.test.ts`, `docs/verification/*.md`의 검증 기록. **제품 코드(packages/, apps/) 수정 금지.**
- 할 일: 지정 커밋을 detach checkout → typecheck/test 재실행 → 이슈 완료 조건마다 독립 fixture·부정 사례 테스트 작성 → 실제 파일·해시·저널 대조.
- 반환: 완료 조건별 PASS/FAIL/NOT-RUN 표, 실패 재현 방법, 새 테스트 커밋 SHA. 자기 평가만으로 PASS 처리 금지.

## 반환 양식 (builder/verifier 공통)

```
Issue: #N   Role:   Base SHA:   Branch:   Commit(s):
Changed files:
Commands run + 실제 결과(테스트 수 pass/fail/skip):
Verification level: Implemented / Unit-verified / Physical(macOS, 이 Mac) / Windows 미검증
Acceptance criteria: 항목별 done / partial / not done (+근거)
Unresolved risks / 다음 작업자에게:
```
