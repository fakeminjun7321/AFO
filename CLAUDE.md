# AFO 개발 진입점

먼저 @AGENTS.md 를 읽고 현재 요청의 범위와 사용자 작업 보호 규칙을 지킵니다.

- 프로젝트 계획: @docs/PLAN.md
- 에이전트 실행과 하네스: @docs/HARNESS.md
- 작업 목록과 선행 관계: @docs/BACKLOG.md
- 파일 작업 계약: @docs/ARCHITECTURE.md
- 검증 기준: @docs/VERIFICATION.md

- 과업↔Issue 매핑: @docs/PLAN_MAPPING.md · 결정: @docs/DECISIONS.md

#19의 읽기 전용 엔진·CLI는 PR #20으로 main에 반영됐고 남은 기반 작업은 #4(H-0·C-1·A-1)에서 이어 갑니다. 실제 이동·삭제, GUI, 앱 내 규칙 자동 저장은 후속 과제입니다.
개발 하네스(`.claude/agents/`, `.claude/skills/`, `.claude/settings.json` 훅, `scripts/harness/`)는 #5 파일럿 단계입니다. 직렬(구현 1 + 검증 1) 흐름만 실측했고 worktree 병렬 모드와 학교 안내 harness 플러그인 설치는 미검증·승인 대기입니다(D18).
이 문서를 읽었다는 것과 에이전트/권한 격리가 실제 동작한다는 것을 구분합니다.

세션 시작 시 `/afo-resume`, 과업 진행은 `/afo-workflow`. 진행 상태의 정본은 GitHub Issue입니다.
