# #9 로컬 GUI(`gui`) 첫 구현 검증

대상: #9, 브랜치 `feat/9-local-gui`(기준 `433819d`). 날짜: 2026-10-29. 작성자가 직접 확인한 기록이며 독립 verifier 검증 전입니다.
범위는 CLI가 띄우는 **보기 전용 로컬 브라우저 화면**입니다. 화면에서 실행(apply·undo)·규칙 변경은 하지 않으며, 데스크톱 앱 패키징·배포는 범위 밖입니다.
이 첫 구현 기록은 그대로 두고, 화면에서 실행·되돌리기와 오른쪽 클릭 메뉴를 더한 2차 기록은 아래 "2차: 화면에서 실행하기"에 있습니다.

## 구현한 범위

- `gui [<폴더>] [--port] [--no-open]`: 127.0.0.1 HTTP 서버, 무작위 토큰(URL `#` 뒤), Host·Origin 검사, strict CSP, 기본 브라우저 열기, Ctrl+C 종료
- 화면 5개: 미리보기, 정리 계획(계획 저장·승인 코드·`apply` 명령 복사), 개인 규칙, 실행 기록(파일 이름·`undo` 명령), 복구 점검
- 공용 함수 재사용을 위한 작은 리팩터링: `plan.ts`의 `createPlan`, `apply.ts`의 `runSummaries`·`recoverReport`. CLI 출력·종료 코드는 그대로입니다(전체 테스트 통과).

## 실행 환경과 결과

```text
Environment: macOS 27.0.1 (26A434) arm64, 실물 Mac, Node.js v24.18.0, npm 11.16.0
npm run typecheck  -> exit 0
npm test           -> tests 430 / pass 421 / fail 0 / skipped 9
node --test dist/tests/gui.test.js -> tests 6 / pass 6 / fail 0
```

skipped 9는 기존의 환경 조건 테스트(`AFO_REAL_TRASH_TEST=1`, 디스크 이미지 등)입니다. 새 `gui.test.ts`의 Ctrl+C 사례는 Windows에서만 건너뜁니다.

## 브라우저 수동 확인 (합성 폴더)

scratchpad에 만든 합성 폴더(문서·이미지·영상·음악·압축·설치 파일 14개, 내용이 같은 PDF 3개, `정리됨/수업/` 2개)와 별도 `AFO_STATE_DIR`로 Claude 데스크톱 앱 내장 브라우저에서 확인했습니다.

| 단계 | 확인한 것 | 결과 |
| --- | --- | --- |
| `gui <폴더> --no-open --port 47321` 후 주소 열기 | 열자마자 분석, 개수 요약(19개·이동 15·검토 4·중복 1묶음), 목적지 폴더별 묶음, 파일별 표 | PASS |
| 정리 계획 탭 → 중복 포함 → 계획 만들기 | 이동 13·휴지통 2·검토 4, 계획 ID·만료, 방식별 승인 코드와 `apply … --mode organize` 명령 | PASS |
| 화면의 명령·코드로 CLI `apply --mode organize --confirm <코드>` | 13개 이동 성공(exit 0). 화면은 파일을 바꾸지 않았고 CLI만 실행 | PASS |
| 실행 기록 탭 → 자세히 | 항목별 `이동함`·원래 위치 → 정리 위치, 공간 설명, `undo <실행 ID>` 명령 | PASS |
| 라이트 모드 + 375px 폭 | 가로 스크롤 없음(scrollWidth 375), 버튼·폼 배치 | PASS(체크박스가 늘어나던 CSS 결함을 고친 뒤 재확인) |
| 콘솔 | 오류 없음 | PASS |

## 검증하지 못한 것

| 항목 | 이유 |
| --- | --- |
| Windows 실물·Windows의 브라우저 자동 열기(`rundll32 url.dll`) | 이 Mac에서 확인할 수 없음. CI 결과로 대신하지 않음 |
| macOS `open`으로 기본 브라우저 자동 열기 | 테스트·수동 확인 모두 `--no-open`으로 실행함 |
| 복사 버튼의 실제 클립보드 기록 | 내장 브라우저에서 클립보드를 바꾸지 않음 |
| 1,000개 이상 폴더의 화면 응답성 | 측정하지 않음. 표는 500개까지 표시 |
| 키보드만으로 전체 흐름, 스크린 리더 | 탭·버튼은 기본 요소지만 전 과정을 확인하지 않음 |
| 독립 verifier 검증 | 아직 하지 않음 |

## 2차: 화면에서 실행하기·폴더 오른쪽 클릭 메뉴

대상: 브랜치 `feat/ux-gui-exec`(기준 `ce7d4ec`). 날짜: 2026-11-02. 작성자가 직접 확인한 기록이며 독립 verifier 검증 전입니다.

### 바뀐 것

- `POST /api/apply { planId, mode: organize|trash }` → `applyCommand`(issueApproval → consumeApproval → executeBatch). 승인 코드는 서버가 저장된 계획에서 계산합니다. `permanent-delete`는 400.
- `POST /api/undo { runId }` → `undoCommand`(확인 코드 = 실행 ID 앞 8자). 이동 실행만 되돌립니다.
- 화면: [정리하기]·[중복 사본 휴지통으로 보내기] → 화면 안 확인 상자(개수·처음 20개·되돌림 가능 여부, 휴지통은 "확인했어요" 체크 필요) → 결과(개수, 성공하지 않은 파일별 이유). 실행 기록의 [되돌리기]와 그 확인 상자. "터미널로 하려면"에 같은 명령.
- `gui --exit-when-closed`: `POST /api/ping`(10초마다)·`GET /api/presence`(열어 둠). 페이지가 없으면 60초(첫 페이지는 120초) 뒤 종료 0.
- `install.sh`: `~/Library/Services/AFO로 정리.workflow`(Finder, 폴더, Run Shell Script /bin/zsh, 인수로 입력, 분리 실행). `install.ps1`: `%APPDATA%\Microsoft\Windows\SendTo\AFO로 정리.lnk`(`afo.exe gui --exit-when-closed`). 둘 다 AFO 표식이 없는 같은 이름 항목은 건드리지 않고 `AFO_NO_QUICK_ACTION=1`·`AFO_NO_SENDTO=1`로 끕니다.

### 실행 환경과 결과

```text
Environment: macOS 27.0.1 (26A434) arm64, 실물 Mac, Node.js v24.18.0, npm 11.16.0
npm test -> tests 505 / pass 493 / fail 0 / skipped 12
node --test dist/tests/gui.test.js -> tests 10 / pass 9 / skipped 1 (AFO_REAL_TRASH_TEST=1 휴지통 사례)
```

skipped 12는 환경 조건 테스트(`AFO_REAL_TRASH_TEST=1`, 디스크 이미지 등)입니다. 새 휴지통 API 사례는 이 실행에서 **돌리지 않았습니다**(이 Mac의 실제 휴지통에 파일을 넣지 않음). 휴지통 실행 경로 자체는 CLI `apply --mode trash`와 같은 함수입니다.

### 수동 확인 (scratchpad 합성 폴더, 별도 `AFO_STATE_DIR`)

| 단계 | 확인한 것 | 결과 |
| --- | --- | --- |
| 내장 브라우저로 `gui <폴더> --no-open --port 47333 --exit-when-closed` 열기 | 열자마자 분석(7개, 이동 6, 중복 1묶음) | PASS |
| 정리 계획 → 중복 포함 → [중복 사본 휴지통으로 보내기] | 확인 상자에 `보고서 copy.pdf (남길 파일: 보고서.pdf)`·휴지통 안내, 체크 전 실행 버튼 꺼짐 → 체크 후 켜짐 → [취소](실행하지 않음) | PASS |
| [정리하기] → 확인 상자 → [이대로 정리하기] **더블클릭** | 4개 이동 결과 카드, 상태 폴더의 승인·실행 기록이 각 1개뿐(두 번 보내지 않음), 파일이 `압축/`·`영상/`·`음악/`·`이미지/`로 이동 | PASS |
| 결과 카드 [되돌리기…] → 실행 기록의 확인 상자 → [이대로 되돌리기] | 4개 되돌림·새로 만든 빈 폴더 4개 삭제, 파일이 원래 경로로 돌아옴, 목록의 되돌리기 1회 | PASS |
| 콘솔 | 오류 없음 | PASS |
| 탭 닫기 | 약 61초 뒤 프로세스 종료, stdout `AFO GUI를 종료했습니다(화면이 닫혀 있어 저절로 끝냄). 화면에서 실행·되돌리기 2번을 했어요.` | PASS |

### 단일 실행 파일(`build-binaries.mjs --targets darwin-arm64`, 저장소 밖 출력)

- `afo gui <temp 폴더> --no-open`: `GET /` 200 `text/html`, `/api/info`의 `cli`가 실행 파일 경로(단일 실행 파일에서는 `node <스크립트>`가 아님).
- curl로 `POST /api/plan` → 다른 Origin의 `/api/apply` 403 → `POST /api/apply organize` 200, `exitCode 0`, `moved,moved,moved` → 같은 apply 재시도 422 `APPROVAL_USED`. 이동 전후 `shasum -a 256`이 경로만 바뀌고 같음.
- `AFO_GUI_FIRST_LOAD_MS=1500 … gui --exit-when-closed`: 페이지 없이 약 1초 뒤 종료 0.

### Finder 빠른 동작 (temp HOME, 이 Mac의 `~/Library/Services`는 건드리지 않음)

- 로컬 HTTP로 `install.sh`를 `HOME=<temp>`, `AFO_INSTALL="<temp>/it's afo & co"`로 실행: `Info.plist`·`document.wflow` 모두 `plutil -lint` OK. 스크립트 첫 줄이 `afo='…/it'\''s afo & co/bin/afo'`이고 zsh가 실제 실행 파일 경로로 해석.
- 다시 설치하면 표식이 있는 workflow를 덮어씀. 표식 없는 같은 이름 workflow가 있는 HOME에서는 "AFO가 만든 것이 아닙니다"로 건너뛰고 내용 유지. `AFO_NO_QUICK_ACTION=1`이면 만들지 않음.
- 설치된 afo를 인수를 기록하는 가짜 스크립트(3초 sleep)로 바꾼 뒤 `automator -i "<temp>/정리할 폴더 A" "<temp HOME>/Library/Services/AFO로 정리.workflow"`: automator가 약 1초 만에 0으로 돌아오고, 가짜 afo가 `gui`, `<폴더 경로>`, `--exit-when-closed`를 받았으며 부모가 `1`(분리 실행)이고 3초 뒤 끝까지 실행됨.

### 검증하지 못한 것

| 항목 | 이유 |
| --- | --- |
| Finder에서 실제 오른쪽 클릭 → 빠른 동작 메뉴 표시·실행 | 실제 `~/Library/Services`에 설치하지 않음(`automator -i`로 workflow 실행만 확인). 확장 프로그램 설정에서 켜야 하는 macOS 버전이 있을 수 있음 |
| Windows 보내기 메뉴(.lnk 생성·탐색기에서 실행), 한글 파일 이름의 .lnk 저장 | 이 Mac에서 실행할 수 없음. `release.yml`의 Windows 설치 단계에 temp `APPDATA`로 .lnk 대상·인수를 확인하는 검사를 넣었고 CI 실행 전 |
| 화면에서 실제 OS 휴지통 보내기 | `AFO_REAL_TRASH_TEST=1` 사례를 이 실행에서 돌리지 않음 |
| 백그라운드 탭에서 오래 둔 뒤의 presence 연결 유지 | 브라우저별 장시간 동작을 측정하지 않음 |
| 독립 verifier 검증 | 아직 하지 않음 |
