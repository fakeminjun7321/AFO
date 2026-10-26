# AFO 3세션 인수인계 (2026-10-26, coordinator = 세션 A)

## 현재 상태
- main: #3 OS 어댑터(`packages/filesystem/src/platform.ts`, ADR 0001) + #4 공용 계약·상태 폴더·fixture 병합됨(PR #23).
- PR #26 `integ/m1-followup`: #4 검증 지적 수정. CI 대기 → coordinator가 main 병합.
- 브랜치 `feat/6-7-scan-classify`(1f17428): #6 권한 기반 스캔·#7 분류·중복. verifier 검증 중 → 통과 후 coordinator가 main 병합.
- 세션 A에서 #18 개인 규칙 저장(core-builder) 진행 중.

## 분담
| 세션 | 이슈 | 소유 경로 |
| --- | --- | --- |
| A (coordinator, 기존) | #18, #8, CLI 전체(`apps/cli/**`, `docs/CLI.md`), 통합·병합, #14 macOS 최종 경로 검증 | `packages/engine/src/{rules,plan}.ts`, `packages/filesystem/src/{profiles,approvals}.ts`, `apps/cli/**`, `tests/cli*.test.ts` |
| B | #10 이동·저널·되돌리기, #11 OS 휴지통 실행, #12 선택 영구 삭제·공간 관측 | `packages/filesystem/src/executor.ts`(+필요시 `executor-*.ts`), `tests/executor*.test.ts`, `tests/verify-10*.test.ts`, `docs/verification/ISSUE_10_11_12.md` |
| C | #13 잠금·중단 복구·동시 실행·파일 변경, #9 GUI 확장 | `packages/filesystem/src/{lock,recovery}.ts`, `tests/{lock,recovery}*.test.ts`, `apps/desktop/**`(자체 package.json·lockfile), `docs/adr/0002-gui.md`, `docs/verification/ISSUE_13.md`, `docs/verification/ISSUE_9.md` |

- `packages/contracts/src/index.ts`는 공용: **추가만**, 한 PR에 최소한으로, PR 설명에 추가한 스키마 명시. 기존 필드 변경 필요 시 coordinator와 먼저 합의.
- `platform.ts`·`state.ts`·`grants.ts`·`index.ts`(스캔): 버그 수정만, PR에 별도 커밋으로.
- `package.json`·`package-lock.json`(루트)·`.github/workflows/engine.yml`: coordinator만 수정. 스크립트·CI 변경이 필요하면 요청.

## 다른 작업자(겹치지 말 것)
- 별도 Claude 채팅(PM 세션): `AGENTS.md`, `CLAUDE.md`, `.claude/**`, `scripts/**`(harness 포함), `docs/HARNESS.md`, `docs/PLAN.md`, `docs/BACKLOG.md`, `docs/DECISIONS.md`, `docs/status/**`, 이슈 생성·본문·라벨, #2·#5·#15·#16. 원격 `harness/5-align-pilot` 브랜치.
- Codex: #25 `firebase/**`만.
- 공용 로컬 폴더 `/Users/minjun/AFO`에서 브랜치를 바꾸거나 다른 사람의 미커밋 파일(`scripts/gen-random-testset.mjs`, `.gitignore` 변경 등)을 건드리지 말 것. 자기 worktree에서만 작업.

## 작업 방식(하네스)
- `ROLES.md`(역할·공통 규칙·반환 양식), `DESIGN.md`(목표 설계 + "세션 간 인터페이스"), `CARRYOVER.md`(앞선 검증에서 넘어온 과제)를 따른다. 모두 이 폴더.
- 세션 = coordinator 역할. 구현은 core-builder 서브에이전트(worktree 격리), 검증은 별도 verifier 서브에이전트(제품 코드 수정 금지, 독립 fixture·부정 사례). 동시에 builder 최대 2 + verifier 1.
- 실제 파일 작업은 `mkdtemp(os.tmpdir())` 합성 폴더와 `AFO_STATE_DIR` temp만. 실제 휴지통 검사는 `AFO_REAL_TRASH_TEST=1`일 때 `afo-test-` 합성 파일만, 휴지통 비우기 금지.
- 완료: 자기 브랜치를 `origin/main`에 rebase/merge → push → **PR 생성(base main)** → CI(Windows/macOS) 확인. **main 병합은 coordinator(세션 A)가 함.** PR 본문에 검증 수준(Implemented/Unit/Physical macOS/Windows CI만)과 미검증을 적는다. 이슈에는 코멘트만(본문·라벨·닫기 금지).
- 끝나면 coordinator에게 보고: 브랜치, PR URL, 커밋, 실제 테스트 수, 미해결 위험.
