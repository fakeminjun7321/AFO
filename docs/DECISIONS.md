# 결정 기록과 근거

기준일: 2026-10-23. 변경 때 결정자·이유·영향·관련 이슈를 기록합니다. 사용자 요구와 제안을 구분합니다.

| ID | 상태 | 결정/질문 | 해제 조건 |
| --- | --- | --- | --- |
| D01 | 사용자 확정 | Windows와 macOS 모두, 자동 분류·폴더 저장, 확인 후 삭제 | 요구 변경 시 사용자와 재합의 |
| D02 | 최신 결정으로 변경 | CLI 우선 Node.js + TypeScript, 로컬 파일 처리, 로그인·유료 LLM 없이 핵심 동작. Electron은 GUI 후보 | D10과 플랫폼·배포 기술검증 |
| D03 | 미결정·출시 차단 | 설치형/다운로드 방식이 대회의 URL 직접 실행 요구를 충족하는가 | 담당 교사의 답변과 실제 인정되는 실행 경로 |
| D04 | 제안 | 기본 휴지통 + 명시적으로 선택한 파일의 영구 삭제 모드, 폴더 재귀 삭제/휴지통 전체 비우기 제외 | 기술검증에서 승인·OS 동작·공간 관측·복구 한계 확인 |
| D05 | 제안 | 규칙 기반 첫 버전. 내용 의미 기반 AI·상시 감시·클라우드·전체 디스크 청소는 이후 | 핵심 경로 검증 후 별도 범위 승인 |
| D06 | 제안 | 조정 1, 구현 최대 2, 검증 1. worktree·경로 소유권·PR·사람 병합 | 작은 실제 과제로 하네스 로드·격리·검증 파일럿 통과 |
| D07 | 미결정 | 지원 OS 최소 버전·CPU, 실제 테스트 기기, 서명·계정·비용 | 두 공동개발자의 장비·계정 확인과 플랫폼 ADR |
| D08 | 미결정 | 심사표의 AI 활용/확장 가능성과 비즈니스 모델/시장성 중 실제 기준 | 담당 교사의 안내 |
| D09 | 사용자 승인·미구현 | 자동 분류 안에 참고 폴더 기반 개인화: 확인된 규칙 저장·재사용, 명시적 수정 반영·초기화. 참고 원본 보존, 삭제 규칙 추정 제외 | #18과 UI #9, 양 OS 통합 #14에서 실제 동작 검증 |
| D10 | 사용자 결정 2026-10-26 | CLI를 먼저 완성하고 GUI로 확장한다. 두 인터페이스는 같은 계약·엔진·승인·파일 실행 서비스를 사용한다 | CLI #14 검증 후 GUI #9. GUI 프레임워크·제공일은 후속 결정 |

## 사용자 제공 대회 자료

원본 두 PDF는 사용자 제공 자료입니다. 저장소에 개인정보가 포함된 원본이나 로컬 절대 경로를 올리지 않습니다.

- **AI-SW개발 해커톤 주간 참가 학생 안내문**, 1쪽: 일정·사전 과제·URL 직접 실행·5분 영상. 2쪽: 구현력 40점, AI 활용 및 확장 가능성 20점.
- **AI-SW개발 해커톤 사전 학습 자료**, 디자인 싱킹 절: 인터뷰 3명, 핵심 기능 최대 2개. 하네스 절: `revfactory/harness`, 역할 파일·작은 요청·직접 실행 검증. Firebase·기획서 절: 배포 연습과 1쪽 기획서. 심사 기준 절: 비즈니스 모델 및 시장성 20점.

두 자료의 심사표가 달라 최신 기준을 추정하지 않았습니다. 문의는 준비 과제이며 아직 교사에게 메시지를 보내지 않았습니다.

## 확인한 공식/원저자 자료

2026-10-23 조회. 프로젝트에서의 실제 동작은 후속 기술검증에서 따로 확인해야 합니다.

- [Electron security](https://www.electronjs.org/docs/latest/tutorial/security): renderer/main 경계, IPC·권한·보안 설정의 근거.
- [Electron shell.trashItem](https://www.electronjs.org/docs/latest/api/shell#shelltrashitempath): OS별 휴지통 동작과 Promise 결과. 앱 내 복원·실제 디스크 확보를 보장하는 API로 해석하지 않음.
- [MDN showDirectoryPicker](https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker): 브라우저 호환성·사용자 선택·권한·보호 경로 제한. 웹에서 전체 디스크 조작을 약속하지 않는 근거.
- [Claude Code subagents](https://code.claude.com/docs/en/sub-agents): 역할 정의·도구·권한·worktree. 사용 중인 버전의 실제 지원 여부는 파일럿으로 확인.
- [Claude Code hooks](https://code.claude.com/docs/en/hooks): 검증·정책 연결 지점. hooks만으로 OS 파일 격리를 보장하지 않음.
- [revfactory/harness 고정 commit](https://github.com/revfactory/harness/tree/92d9f1b29e7af81acebf51a9fcd1832e739a1414): 팀 구성 파일 생성과 작업 흐름의 참고 자료. README의 효과 수치를 AFO의 검증 결과로 사용하지 않음.
