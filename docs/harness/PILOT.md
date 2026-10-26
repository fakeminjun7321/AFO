# 하네스 검증 기록 (HX-1, 2026-10-26)

> 이 문서는 GitHub 연결 전 별도 로컬 저장소에서 수행한 파일럿 기록입니다. 당시 역할 이름은 PM·developer·reviewer이며 이후 HARNESS.md의 coordinator·core-builder·verifier로 이식했습니다(D12). 아래 표의 수치는 당시 결과이며, 이식 후 재검증은 맨 아래 "GitHub 이식 후 재검증" 절에 따로 적습니다.
> 2026-10-26 작업 분담(제품 코드 경로 `tests/**`·`docs/verification/**`는 코드 세션 소유)에 따라 시험 산출물을 `docs/harness/pilot/`로 옮겼습니다. 본문의 `sandbox/harness-trial/`·`tests/unit/harness-trial/`·`tests/review/T-000/` 경로는 당시 위치입니다.

환경: 클라우드 작업 공간(Linux), Node 22.23.4, Claude Code 2.1.310(헤드리스 `claude -p`), 로컬 git 저장소. GitHub 원격은 미연결(계정 미연결로 저장소 접근 불가). Windows·macOS 실제 기기 검증은 하지 않았다.

## 1. 자동 테스트

| 항목 | 명령 | 결과 |
| --- | --- | --- |
| 하네스 자체 테스트(정책 12 + 훅·CLI 통합 11) | `node --test scripts/harness/test/*.test.mjs` | 23 통과 / 0 실패 |
| 전체 검사 | `node scripts/harness/run-checks.mjs` | 하네스 23, 프로젝트 7, 리뷰 2 통과 · RESULT: PASS |

## 2. 실제 Claude Code에서의 동작(헤드리스 실측)

| 확인 항목 | 방법 | 결과 |
| --- | --- | --- |
| 프로젝트 훅 입력에 서브에이전트 `agent_type`이 들어오는가 | 입력을 기록하는 시험 훅 | 들어옴(`agent_type`, `agent_id`) → 역할 구분 근거 |
| 서브에이전트 frontmatter의 `hooks`가 실행되는가 | 시험 에이전트에 PreToolUse·Stop 훅 정의 | **실행 안 됨** → 프로젝트 훅으로 대체(decisions.md) |
| 세션 시작 상태 주입 | 모델에게 주입 내용 인용 요청 | 첫 줄 정확히 인용 |
| 커스텀 에이전트 인식 | 모델에게 목록 요청 | developer, reviewer |
| developer가 `tests/review/` 쓰기 | 위임 | 훅이 거부, 사유 전달 |
| reviewer가 구현 파일(`sandbox/`) 쓰기 | 위임 | 훅이 거부, 사유 전달 |
| PM이 구현 코드(`packages/`) 쓰기 | 직접 시도 | `ask` → 헤드리스에서 거부(대화형에서는 사용자 확인) |
| 셸 리디렉션으로 파일 쓰기(`cat > …`) | 시험 사이클 중 자연 발생 | 권한 거부 → Write 도구로 전환(훅 적용됨) |
| 허용 목록에 없는 명령 | 시험 사이클 중 드릴 명령 | PM이 우회하지 않고 멈춰 승인 요청 |

## 3. 시험 과업 T-000 사이클(Developer → Reviewer → 수정 → 재검증)

| 단계 | 결과 | 증거 |
| --- | --- | --- |
| 과업 선정·시작·브랜치 | `feat/t-000-trial-format-duration` | git 브랜치, current-task.json |
| developer 1차 구현 | 구현 + 단위 테스트 7개 | sandbox/harness-trial/, tests/unit/harness-trial/ |
| 결함 주입(드릴) | RangeError → TypeError | .afo/state/drills.log(로컬) |
| reviewer r1 | **FAIL** — 결함을 차단 항목으로 지적, 리뷰 테스트 추가 | docs/reviews/T-000-r1.md |
| PM → developer 수정 지시, 수정 | RangeError 복구 | 커밋 e75c4e7 |
| reviewer r2 | **PASS**, 전체 검사 통과 | docs/reviews/T-000-r2.md |
| 기록·커밋·브리핑 | log.md·STATUS.md 갱신, 5줄 브리핑 후 멈춤 | 커밋 e75c4e7, 166aca1 |
| 범위 밖 변경 | 0건 | `task.mjs violations` |
| 새 세션에서 `OK` | 상태 복원, 사람 작업이 막고 있어 사이클을 시작하지 않고 보고 | 헤드리스 실행 결과 |

## 4. 사이클에서 발견해 고친 하네스 문제

1. 드릴 명령이 허용 목록에 없어 헤드리스에서 멈춤 → 허용 목록 추가.
2. 첫 developer가 셸 쓰기 거부 후 테스트를 실행하지 않고 끝냄(종료 훅의 검사는 통과) → 지침에 "파일 쓰기는 Write/Edit, Bash는 실행용, 검사 결과를 보고서에 옮김" 추가.
3. reviewer r1이 추가 테스트를 실행하지 않고 "미실행"으로 보고 → 종료 훅이 "리뷰 테스트 수정 이후의 전체 검사 기록"을 요구하도록 변경(테스트 추가).
4. 새 세션의 상태 확인 명령 일부(`gh`, `ls`)가 허용 목록 밖 → 읽기 전용 명령 허용.

## 5. 아직 검증하지 못한 것

- Windows·macOS 실제 기기에서 훅 실행(특히 Windows Git Bash에서 `"$CLAUDE_PROJECT_DIR"` 경로 처리) → SPK 기간(10/27~28) 각자 기기에서 `claude` 실행 후 2절 항목 재확인.
- 대화형 모드에서 `ask`가 사용자 확인으로 뜨는지.
- GitHub Issue·PR 연동(`gh` 인증 후).
