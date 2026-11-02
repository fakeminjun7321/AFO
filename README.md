# AFO — Automated File Organizer

흩어진 파일을 종류별 폴더로 정리하고, 확인한 중복 파일만 휴지통으로 보내거나 지우는 명령줄 프로그램입니다.
모든 처리는 내 컴퓨터 안에서만 하며 로그인·서버 업로드가 없습니다. 교내 AI-SW 개발 해커톤 출품작입니다.

## 설치

**macOS** (터미널):

```sh
curl -fsSL https://raw.githubusercontent.com/fakeminjun7321/AFO/main/install.sh | sh
```

**Windows** (PowerShell):

```powershell
irm https://raw.githubusercontent.com/fakeminjun7321/AFO/main/install.ps1 | iex
```

Node.js 등 다른 프로그램은 필요 없습니다. 설치 스크립트는 [GitHub Releases](https://github.com/fakeminjun7321/AFO/releases)에서 내 OS용 실행 파일 하나를 받아 `SHA256SUMS`와 대조한 뒤 설치하고 PATH에 추가합니다. 설치가 끝나면 그 터미널에서 바로 `afo`를 입력하세요(macOS에서 아래 연결 폴더가 없을 때만 새 터미널이 필요합니다).

| OS | 설치 위치 | PATH |
| --- | --- | --- |
| macOS (Apple Silicon·Intel) | `~/.afo/bin/afo` | 이미 PATH에 있는 `~/.local/bin`·`/opt/homebrew/bin`·`/usr/local/bin` 중 쓸 수 있는 곳에 `afo` 링크(바로 사용). 없으면 `~/.zshrc`(bash는 `~/.bash_profile`)에 한 줄 추가 |
| Windows 10/11 (x64, Arm은 에뮬레이션) | `%LOCALAPPDATA%\Programs\AFO\afo.exe` | 사용자 PATH에 추가 |

- 특정 버전: `curl -fsSL …/install.sh | AFO_VERSION=0.1.0 sh`. PATH를 직접 관리하려면 `AFO_NO_MODIFY_PATH=1`.
- 실행 파일은 코드 서명·공증을 받지 않았습니다. 설치 스크립트로 받으면 macOS에서 바로 실행되지만, 브라우저로 직접 받은 파일은 Gatekeeper가 막을 수 있습니다. Windows에서는 SmartScreen·백신 경고가 나올 수 있습니다.

## 사용법

```sh
afo            # 폴더를 터미널에 끌어다 놓고 안내를 따름 → 확인 코드를 입력해야 실제로 정리
afo undo       # 가장 최근 정리를 원래대로 되돌리기
afo runs       # 정리 기록 보기
afo --help     # 모든 명령
```

`afo`는 분석 요약을 보여 준 뒤 **폴더별 정리**(되돌릴 수 있음) 또는 **중복 파일 휴지통 보내기**를 고르게 합니다. 화면에 나온 확인 코드를 직접 입력해야 파일이 움직입니다.
스크립트처럼 쓰려면 `preview`(미리보기) → `plan`(계획 저장) → `apply`(승인 코드로 실행) → `undo`를 사용합니다. 개인 정리 규칙(`suggest-rules`, `rules`)과 종료 코드는 [CLI 문서](docs/CLI.md)에 있습니다.

```sh
afo preview "/정리할/테스트 폴더"     # 파일을 바꾸지 않고 정리안만 보기
afo plan "/정리할/테스트 폴더"        # 계획 ID와 방식별 승인 코드 출력
afo apply <계획 ID> --mode organize --confirm <승인 코드>
```

### 화면으로 보기

```sh
afo gui "/정리할/테스트 폴더"
```

이 컴퓨터(127.0.0.1)에서만 열리는 브라우저 화면이 뜨고, 미리보기·정리 계획·개인 규칙·실행 기록·복구 점검을 보여 줍니다. 화면은 파일을 옮기거나 지우지 않으며, 실행은 화면이 알려 주는 `apply` 명령으로 터미널에서 합니다. 자세한 내용은 [CLI 문서](docs/CLI.md#화면으로-보기-gui)를 봅니다.

## 할 수 있는 것과 검증 상태

| 기능 | 상태 |
| --- | --- |
| 폴더 스캔·제외 규칙(링크·하드링크·숨김·시스템·개발 폴더) | 구현, macOS 실물 검증 |
| 확장자 기반 분류, 내용 해시(SHA-256) 중복 찾기 | 구현, macOS 실물 검증 |
| 기존 정리 폴더를 참고한 개인 규칙 제안·저장·재사용 | 구현, macOS 실물 검증 |
| 정리 계획·한 번의 배치 승인(승인 코드) | 구현, macOS 실물 검증 |
| 실제 폴더 생성·이동·되돌리기, OS 휴지통 보내기, 선택 파일 영구 삭제 | 구현, macOS 실물 검증 |
| 중단 복구 보고(`recover`), 같은 폴더 동시 실행 잠금 | 구현, macOS 실물 검증 |
| curl/PowerShell 설치 | macOS 실물에서 설치·실행 검증, Windows는 CI에서만 확인 |
| 로컬 화면(`afo gui`, 보기 전용) | 구현, macOS 실물 검증. 화면에서 실행하기는 후속([#9](https://github.com/fakeminjun7321/AFO/issues/9)) |

"macOS 실물 검증"은 실제 Mac에서 합성 테스트 파일로 확인했다는 뜻입니다. **Windows 실제 PC에서의 검증은 아직 하지 않았습니다**(GitHub Actions의 Windows VM에서만 테스트). 검증 기록은 [docs/verification](docs/verification/)에 있습니다.

## 안전 장치

- 정리할 폴더 안의 파일만 다룹니다. 홈 폴더 전체·디스크 루트·시스템 폴더·개발 프로젝트는 거부하거나 제외합니다.
- 파일을 덮어쓰지 않습니다. 이름이 겹치면 검토 대상으로 남깁니다.
- 승인 코드는 그 계획·그 작업 목록·그 방식에 한 번만 유효합니다. 실행 직전에 파일을 다시 확인해 그사이 바뀐 파일은 건너뜁니다.
- 기본 삭제는 OS 휴지통입니다. 영구 삭제는 별도 방식과 확인 문구("영구 삭제")가 필요하며 되돌릴 수 없습니다.
- 크기·날짜만으로 지울 파일을 정하지 않습니다. 이름이 같아도 내용이 다르면 중복이 아닙니다.

## 업데이트와 제거

업데이트는 설치 명령을 다시 실행하면 됩니다. `afo --version`으로 버전을 확인합니다.

제거(macOS): `rm ~/.afo/bin/afo`와 설치 때 안내된 링크(예: `rm ~/.local/bin/afo`)를 지우고, `~/.zshrc`에 `# AFO` PATH 줄이 있으면 지웁니다.
제거(Windows): `Remove-Item "$env:LOCALAPPDATA\Programs\AFO" -Recurse` 후 사용자 환경 변수 PATH에서 그 폴더를 지웁니다.

규칙·계획·실행 기록은 따로 저장됩니다. macOS는 `~/Library/Application Support/AFO`, Windows는 `%LOCALAPPDATA%\AFO`입니다. 이 폴더를 지우면 저장한 규칙과 `afo undo` 기록도 사라집니다.

## 개발

Node.js 24와 npm이 필요합니다.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test                                   # 빌드 + 전체 테스트(합성 temp 폴더만 사용)
npm run afo -- preview "/path/to/test-folder"
npm run release:build -- --targets darwin-arm64   # 단일 실행 파일 만들기(release/)
```

`v*` 태그를 올리면 [릴리스 워크플로](.github/workflows/release.yml)가 macOS(arm64·x64)·Windows(x64) 실행 파일을 만들고, 세 OS에서 설치 스크립트로 설치·실행을 확인한 뒤 GitHub Release에 올립니다. 태그는 `package.json`의 버전과 같아야 합니다.

| 문서 | 내용 |
| --- | --- |
| [CLI 사용법](docs/CLI.md) | 모든 명령·옵션·종료 코드 |
| [개발 환경](docs/DEVELOPMENT.md) | 설치·검사 명령과 실제 실행 기록 |
| [설계](docs/ARCHITECTURE.md) | 모듈 경계, 파일 작업 계약, 삭제·복구 정책 |
| [인터페이스 설계](docs/INTERFACES.md) | CLI·GUI가 공유하는 서비스와 계약 |
| [검증 계획](docs/VERIFICATION.md) | 테스트 사례, Windows/macOS 실물 검증, 출시 기준 |
| [개발 계획](docs/PLAN.md) · [작업 목록](docs/BACKLOG.md) | 범위, 일정, 이슈와 선행 관계 |

## 라이선스

[Apache License 2.0](LICENSE). 배포하는 실행 파일에는 Node.js(`LICENSE-node`)와 zod(`LICENSE-zod`)의 라이선스 고지가 함께 들어 있습니다.
