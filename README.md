# AFO — Automated File Organizer

파일 정리가 귀찮거나 저장공간이 부족한 사용자를 위한 자동 파일 관리 프로그램입니다.
교내 AI-SW 개발 해커톤 출품을 목표로 공동 개발합니다.

**CLI 우선으로 개발하고, 이후 같은 엔진을 사용하는 GUI로 확장합니다.** CLI에서 분석·승인·정리·복구의 핵심 경로를 먼저 완성합니다. GUI 없이도 사용할 수 있게 하며 현재 구현은 읽기 전용입니다.

## 핵심 기능

1. **자동 분류·저장**: 흩어진 파일을 종류와 용도에 맞게 분류하고 알맞은 폴더로 정리합니다. 선택한 기존 폴더의 정리 방식을 참고해 확인한 개인 분류 규칙을 저장·재사용합니다.
2. **확인 후 삭제**: 중복 파일 등 삭제 후보와 이유를 보여 주고, 사용자가 승인한 항목만 실제로 삭제합니다.

## 현재 구현 범위

**첫 단계는 실제 폴더를 읽는 엔진과 CLI입니다.** 기본 분류, 콘텐츠 해시 중복 후보, 참고 폴더의 규칙 제안·명시적 확인, 충돌을 표시하는 정리 미리보기를 구현했습니다.
이 버전에는 파일 이동·삭제·앱 내 규칙 자동 저장·데스크톱 UI가 없습니다. `move`는 이동 제안이며 실제 변경이 아닙니다.
프로필 JSON의 `confirmed`는 분류 규칙의 확인 상태입니다. 파일 작업 승인이나 실행 권한이 아닙니다.

목표 운영체제는 **Windows와 macOS**입니다. Node.js + TypeScript CLI가 주 인터페이스이며 Electron 등은 추후 GUI 후보입니다. 대회의 URL 직접 실행 조건에서 CLI 산출물이 인정되는 방식은 별도로 확인해야 합니다. [첫 구현 검증 기록](docs/verification/READ_ONLY_ENGINE.md)을 참고하세요.

## 로컬에서 실행하기

Node.js 24와 npm이 필요합니다. 의존성 버전과 lockfile을 고정했습니다.

가장 쉬운 사용법(설치 1회 → 안내 따르기 → 되돌리기). 자세한 내용은 [CLI 문서](docs/CLI.md#빠른-시작)를 봅니다.

```sh
npm ci --ignore-scripts && npm run build && npm link   # 설치 1회, 제거는 npm unlink -g afo
afo                                                   # 폴더를 끌어다 놓고 안내를 따름(확인 코드를 입력해야 실행)
afo undo                                              # 가장 최근 정리 되돌리기
```

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build
npm run afo -- --help
```

분석할 폴더를 직접 지정합니다. 아래 경로는 설명용이며 본인이 만든 테스트 폴더로 바꿉니다. 경로에 공백이 있으면 따옴표를 유지합니다.

```sh
npm run preview -- "/path/to/test-folder"
npm run afo -- preview "/path/to/test-folder"
node dist/apps/cli/src/index.js preview "/path/to/test-folder" --json
```

Windows에서는 예를 들어 `"C:\AFO-Test"`를 지정할 수 있습니다. 홈 전체·디스크 루트·시스템 폴더·개발 프로젝트는 거부하거나 제외합니다.
숨김 경로·앱 번들·링크/junction·다중 하드링크도 제외하며 한도·읽기 실패는 불완전 상태로 표시합니다.
같은 크기의 후보만 스트리밍 SHA-256으로 비교하고, 파일 크기·날짜만으로 불필요하다고 판정하지 않습니다. 대용량 표시의 초기 기준은 100 MiB이며 삭제나 확보량을 뜻하지 않습니다.

### 참고 폴더에서 규칙 제안하고 재사용하기

```sh
node dist/apps/cli/src/index.js suggest-rules "/path/to/reference" > draft.afo-profile.json
node dist/apps/cli/src/index.js confirm-rules draft.afo-profile.json --select "확인한규칙ID" > confirmed.afo-profile.json
node dist/apps/cli/src/index.js preview "/path/to/test-folder" --profile confirmed.afo-profile.json
```

`draft.afo-profile.json`의 근거와 목적지를 먼저 읽고 `--select`에 실제 규칙 ID를 넣습니다. 여러 규칙은 쉼표로 구분합니다. 내보내기는 사용자가 선택한 shell 리다이렉션이며 앱이 파일을 자동 저장하는 기능은 아닙니다.
프로필에는 참고 폴더의 로컬 경로·파일명이 포함됩니다. 저장소에 올리지 않도록 `*.afo-profile.json`을 제외했습니다.
초기 규칙 제안에는 서로 다른 참고 파일 2개 이상의 근거를 요구하며, 확장자가 여러 폴더에 나뉘면 폴더명과 파일명의 연관 근거도 확인합니다. 이 기준의 정확도는 사용자 데이터로 측정하지 않았습니다.
미확인·비활성화 규칙은 적용하지 않고, 충돌은 검토 대상으로 남깁니다. 참고 파일은 이동/삭제 후보에서 보호하며, 참고 파일의 내용은 개인화 추론을 위해 읽지 않습니다.

```sh
npm run typecheck
npm test
```

테스트는 새 temp 폴더에 합성 파일을 만들고, 실제 CLI 프로세스와 독립 전후 manifest를 검증합니다. `.github/workflows/engine.yml`은 Windows/macOS CI 정의이며, 통과 여부와 실제 하드웨어 검증은 구분합니다.

## 개발 시작점

CLI와 GUI는 공용 계약·엔진·파일 서비스를 공유합니다. GUI가 CLI 출력이나 shell 명령을 파싱하지 않으며, 승인·루트 제한·저널·삭제 정책을 우회하지 않도록 합니다. [인터페이스 설계](docs/INTERFACES.md)를 참고하세요.

| 문서 | 내용 |
| --- | --- |
| [개발 계획](docs/PLAN.md) | 범위, 일정, 역할, 먼저 결정할 사항 |
| [GitHub 작업 목록](docs/BACKLOG.md) | 핵심 과제, 선행 작업, 완료 조건 |
| [설계](docs/ARCHITECTURE.md) | 모듈 경계, 파일 작업 계약, 삭제·복구 정책 |
| [에이전트와 하네스](docs/HARNESS.md) | 실행 순서, 동시 작업 제한, 도구 권한, 파일 소유권 |
| [검증 계획](docs/VERIFICATION.md) | 테스트 사례, Windows/macOS 실물 검증, 출시 기준 |
| [결정 기록과 근거](docs/DECISIONS.md) | 확정·제안·미결정 구분, 공식 자료 |

구현할 때는 이슈 하나당 브랜치와 PR 하나를 기본으로 합니다. 현재 첫 구현은 [#19](https://github.com/fakeminjun7321/AFO/issues/19)이며 상위 #4/#6/#7/#8/#18의 전체 완료를 뜻하지 않습니다.
공용 계약은 `packages/contracts/src/index.ts`, 순수 계획 엔진은 `packages/engine/src/index.ts`, 실제 읽기 어댑터는 `packages/filesystem/src/index.ts`입니다. UI 담당자는 쓰기 기능 대신 이 읽기 전용 계약부터 연결할 수 있습니다.
개발 하네스의 파일 생성·로드·실행 검증은 서로 별개로 기록합니다. 파일이 있다는 이유만으로 동작한다고 보고하지 않습니다.
