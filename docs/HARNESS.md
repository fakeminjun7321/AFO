# AFO 에이전트와 하네스 운영 계획

상태: **설계만 작성**. 플러그인 설치, `.claude/agents/`, hooks, 자동 실행, 검증 스크립트는 미구현·미검증입니다.
개발 에이전트가 AFO를 만드는 하네스와, AFO 사용자 파일을 처리하는 앱 실행 계층은 다른 시스템입니다.

## 역할: 팀을 크게 만들지 않기

| 역할 | 하는 일 | 쓰기 범위 | 하지 않는 일 |
| --- | --- | --- | --- |
| coordinator | 선행 조건 확인, 작업 패킷, 공용 계약, 결과 통합, 사용자 보고 | 계획·계약·통합 브랜치, 충돌 조정 | 사람이 승인하지 않은 배포·병합·개인 파일 정리 |
| core-builder | 스캔·분류·계획·파일 실행 | 맡은 packages/와 대응 tests/ | UI 구조 변경, 다른 작업의 경로 수정 |
| desktop-builder | renderer·preload·main 연결·패키징 | 맡은 apps/와 대응 tests/ | 승인 검사 생략, 파일 어댑터 임의 우회 |
| verifier | 독립 테스트, 원본/결과 비교, 실패 재현, PR 검토 | 별도 합성 fixture·검증 로그, 합의한 테스트 경로 | 제품 코드 몰래 수정, 자기 평가만으로 통과 처리 |

coordination은 현재 주 에이전트가 맡고 작업마다 역할을 호출합니다. 역할 네 개가 항상 동시에 실행되는 것은 아닙니다.
동시 상한은 **조정 1 + 구현 2 + 검증 1**입니다. 구현 병렬화는 공용 계약 확정과 경로 분리 후에만 합니다.
파일 실행 엔진·main의 권한 경계·lockfile·공용 스키마는 단일 작성자가 소유합니다. 검증자가 제품 코드를 고쳐야 하면 별도 구현 과제로 전환한 뒤 다른 검토를 받습니다.
설치된 모델 설정을 상속하고 특정 모델 이름을 고정하지 않습니다. 모델 변경이나 추가 유료 서비스를 임의로 도입하지 않습니다.

## 한 이슈를 처리하는 순서

1. coordinator가 최신 사용자 범위, 이슈·선행 조건·기준 SHA·기기/도구를 확인합니다.
2. 사람이 두 작업의 충돌 여부를 보고 담당을 정합니다. GitHub 이슈에 담당·경로·기준 SHA를 남기되 실제 계정 배정은 동의 후 합니다.
3. 별도 브랜치·worktree를 만들고 HEAD와 파일을 다시 확인합니다. 분기 기준이 기본 브랜치라고 추측하지 않습니다.
4. 구현자에게 아래 작업 패킷을 전달하고 작은 변경만 수행하게 합니다.
5. 구현자는 테스트를 실행하고 변경 파일·커밋·실제 명령·출력·미검증을 반환합니다.
6. verifier는 같은 커밋에서 독립 fixture와 부정 사례로 검사하고 실제 파일·해시·저널을 대조합니다.
7. 문제가 있으면 근거와 함께 구현자에게 되돌립니다. 같은 결함의 수정·재검증은 기본 2회 이내로 하고 지속되면 설계·계약을 재검토합니다.
8. coordinator가 계약·문서·충돌을 확인해 PR을 만들고 사람이 병합합니다. 필요한 외부·실물 검증이 남으면 이슈를 열린 상태로 둡니다.

권장 상태: Planned → Ready → Claimed → Implementing → Review → Verified → Merged. Blocked는 이유·해제 조건·담당을 적습니다.
단일 최신 상태는 GitHub 이슈에 두고, 문서에 진행률 숫자를 중복 관리하지 않습니다. 의존성이 완료되면 coordinator가 `status:blocked`를 `status:ready`로 수동 갱신합니다.

## 작업 패킷: 복사해 채울 양식

```text
Issue: URL
Role: core-builder | desktop-builder | verifier
Base commit: SHA
Objective: 사용자가 얻게 될 동작 한 가지
Prerequisites: 선행 이슈·확정 계약·실행 환경
Owned paths: 편집할 경로 / 읽기만 할 공용 경로
Inputs and outputs: 계약 문서·fixture·예상 실제 결과
Allowed actions: 코드 편집·합성 데이터 테스트 등 이번에 맡긴 범위
Forbidden actions: 실제 사용자 파일 조작·전경 제어·배포·자동 병합 등
Acceptance criteria: 이슈 체크리스트
Verification: 실제 명령·fixture·검증할 파일/저널/출력
Stop conditions: 경로 충돌·불명확한 결과·필수 환경 부재
Return: commit, diff summary, evidence, verification level, unresolved risks
```

## 실제 병렬화 계획

- 요구 조사와 플랫폼 검토는 독립적으로 진행할 수 있습니다.
- 기반/계약 이후 core-builder는 스캔→분류→계획을, desktop-builder는 그 계약을 사용하는 UI를 병렬 구현합니다.
- UI의 fixture/mock는 화면 개발용이라고 표시합니다. 파일 실행 완료 이슈의 증거로 쓰지 않습니다.
- 파일 실행, 승인 경계 변경, 복구 작업은 같은 경로를 다루므로 순서대로 진행합니다. verifier는 고정된 snapshot을 검사합니다.
- 실제 삭제·OS 휴지통 검증은 같은 기기·루트에서 한 작업만 수행합니다. CI도 고유 temp 루트로 격리합니다.
- 패키징과 배포 담당은 한 명입니다. 파이프라인이 통과해도 배포와 병합을 자동 승인하지 않습니다.

## 만들 하네스 파일: 후속 구현 이슈의 범위

| 파일/경로 | 계획 |
| --- | --- |
| AGENTS.md / CLAUDE.md | 도구 간 공통 규칙과 Claude 진입점. 이번에는 계획 안내만 존재 |
| .claude/agents/core-builder.md | 담당 경로·완료 조건·설정 상속·작업 격리 정의 |
| .claude/agents/desktop-builder.md | UI/IPC 경계, 같은 패킷 계약 |
| .claude/agents/verifier.md | 제품 코드 읽기 중심, 독립 fixture 검증, 제한된 테스트 실행 |
| .claude/skills/afo-workflow/SKILL.md | 이슈→구현→검증→PR→사람 검토 흐름 |
| .claude/settings.json + scripts/harness/ | 로드/정책/산출물 검사. 공식 설치 버전의 스키마에 맞게 구현·부정 테스트 |
| .github/ISSUE_TEMPLATE/ / PULL_REQUEST_TEMPLATE.md | 범위·의존성·증거·미검증을 누락하지 않는 양식 |
| .github/workflows/ | contracts/engine/OS 통합 검사. 정확한 명령·권한은 기반 이슈에서 구현 |

학교 자료의 `revfactory/harness`는 팀/작업 절차 파일을 생성하는 도구로 사용합니다. 생성 결과를 검토하고 프로젝트 규칙에 맞게 줄입니다.
현재 확인한 upstream main은 `92d9f1b29e7af81acebf51a9fcd1832e739a1414`, README 표기는 v2.1.0입니다(2026-10-23 조회). 설치 시 현재 버전·commit을 다시 확인하고 기록합니다.
upstream의 실행 도구 이름이 실제 설치된 Claude Code/Codex의 기능과 일치한다고 가정하지 않습니다. 공식 문서와 설치된 런타임의 지원 여부를 작은 파일럿으로 확인합니다.
Codex는 AGENTS.md와 동일 작업 패킷을 사용합니다. `.claude` 설정이 Codex에 자동 적용된다고 가정하지 않습니다.

## 강제 장치와 한계

- prompt, Markdown, tool allowlist는 OS 파일 접근을 강제로 격리하는 sandbox를 대신하지 못합니다.
- builder의 쓰기 경로, verifier의 제품 코드 수정 금지, mock/실제 결과 구분을 리뷰·CI로 검사할 계획입니다.
- hooks는 명령 문자열 몇 개를 막는 방식만으로 안전을 보장하지 않습니다. 지원하는 런타임 권한·격리와 앱의 루트/승인 검사를 함께 씁니다.
- 필수 승인/증거 필드가 없거나 잘못된 자료형이면 실패시키고, 실행되지 않은 테스트는 성공으로 기본 처리하지 않습니다.
- 루프/실패 후 실제 반영 상태를 먼저 확인합니다. 오류가 났다고 같은 삭제·배포·커밋을 그대로 재실행하지 않습니다.

## 도입 파일럿과 개선

설정 파일을 만든 뒤 재시작/새 세션에서 로드, 역할 선택, worktree 경로, 권한 경계, 한 작은 합성 파일 과제의 실제 결과를 확인합니다.
필수 부정 사례는 잘못된 역할·경로, 없는 증거, 실패 테스트, 승인 없는 파일 작업, 기존 산출물의 성공으로 오인하는 경우입니다.
하네스 효과는 유사한 작은 과제의 수동/하네스 수행 시간·재작업·오류·도구 사용량으로 비교합니다. 측정 전에는 품질/토큰/시간이 개선됐다고 주장하지 않습니다.
실패가 확인되면 해당 규칙·회귀 사례·근거를 저장소에 연결하고 같은 종류의 후속 작업에서 효과를 관찰합니다. 사용자 전역 메모리는 별도 명시 요청 없이는 수정하지 않습니다.

공식 근거는 [DECISIONS.md](DECISIONS.md)를 참고합니다.
