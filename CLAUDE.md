# AFO 개발 진입점

먼저 @AGENTS.md 를 읽고 현재 요청의 범위와 사용자 작업 보호 규칙을 지킵니다.

- 프로젝트 계획: @docs/PLAN.md
- 에이전트 실행과 하네스: @docs/HARNESS.md
- 작업 목록과 선행 관계: @docs/BACKLOG.md
- 파일 작업 계약: @docs/ARCHITECTURE.md
- 검증 기준: @docs/VERIFICATION.md

현재 #19의 읽기 전용 엔진·CLI를 구현하고 있습니다. 실제 이동·삭제, 데스크톱 UI, 앱 내 규칙 자동 저장은 후속 과제입니다.
`.claude/agents/`, `.claude/skills/`, hooks와 개발 에이전트 실행 하네스는 아직 구현하지 않았습니다.
학교에서 안내한 harness 플러그인은 추후 별도 이슈에서 설치·설정하고 실제 로드·작업 수행까지 검증합니다.
이 문서를 읽었다는 것과 에이전트/권한 격리가 실제 동작한다는 것을 구분합니다.
