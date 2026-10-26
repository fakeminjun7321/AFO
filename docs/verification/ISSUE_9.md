# #9 GUI 첫 단계(읽기 전용 로컬 웹 화면) 구현 기록

역할: interface-builder. 날짜: 2026-10-26. 기준 `origin/feat/6-7-scan-classify` `38d4479`(grants.ts·analyzeRoot 포함), 브랜치 `feat/9-gui-readonly`.
설계: [ADR 0002](../adr/0002-gui.md). 이 문서는 구현자 기록이며 독립 verifier 검증이 아닙니다.

## 구현한 것

- `apps/desktop/` 자체 `package.json`·`package-lock.json`(zod 4.6.7, 개발용 typescript 5.9.3·@types/node 24.19.2 — 루트와 같은 버전). 루트 package.json·lockfile·tsconfig, `packages/**`, `apps/cli/**`, 루트 `tests/**`, `.github/**`는 바꾸지 않았습니다.
  `tsconfig.json`은 루트 설정을 상속하고 공용 패키지를 상대 경로(`../../../packages/...`)로 함께 컴파일합니다. `zod`는 `paths`로 `apps/desktop/node_modules`를 가리켜 루트 `node_modules` 없이도 빌드됩니다(아래 확인).
- `src/server.ts`: Node 내장 `node:http`. `127.0.0.1` + 포트 0(OS 선택), 실행마다 256비트 토큰. ADR 보안 표의 각 행:
  - `Host`가 정확히 `127.0.0.1:<port>`가 아니면 421(`BAD_HOST`), `Origin`이 있으면 정확히 `http://127.0.0.1:<port>`여야 함(403). 추가로 `Sec-Fetch-Site`가 있으면 `same-origin`/`none`만 허용.
  - API는 `POST /api/<채널>` + `Content-Type: application/json` + `X-AFO-Token`(sha256 후 `timingSafeEqual`)만. CORS 헤더를 보내지 않음. 본문 64 KiB 한도(선언 길이·chunked 모두 413).
  - 정적 파일은 `/`, `/index.html`, `/app.js`, `/style.css` 허용 목록의 정확한 문자열 일치만. 시작 시 메모리에 읽어 두며 다른 경로(인코딩된 `..` 포함)는 404.
  - 모든 응답에 ADR의 CSP 그대로, `nosniff`, `no-referrer`, `no-store`(+ `X-Frame-Options: DENY`, COOP/CORP same-origin).
  - 응답은 `{ ok: true, data }` / `{ ok: false, error: { code, message } }`. AfoError 코드·메시지는 그대로, 그 밖의 오류는 경로·스택 없는 일반 메시지(`INTERNAL`).
- `src/service.ts`(전송 계층과 무관한 채널 처리 — 후속 Electron IPC에서도 재사용 가능): `select-folder`(입력 경로 → `issueRootGrant`/`issueReferenceGrant`), `pick-folder`(OS 대화상자 → 같은 경로), `analyze`(`verifyGrant` 후 `analyzeRoot`를 AbortController·onProgress와 함께 백그라운드 작업으로), `job`(진행·결과·오류), `cancel`, `confirm-rules`(서버가 보관한 그 작업의 제안 프로필에 `confirmProfile`; 클라이언트는 프로필을 보내지 않음). 확인된 프로필은 서버가 ID로 보관하고 `analyze`의 `profileId`로 재분석합니다. 채널마다 `z.strictObject`.
  이 서버가 발급한 grant ID만 받으며, 같은 종류 폴더를 다시 고르면 이전 grant를 `revokeGrant`합니다. 파일시스템 쓰기는 없습니다. 규칙 저장(#18 저장소)은 이 기준에 없어 후속입니다(화면에 "저장은 후속" 표시).
- `src/os.ts`: macOS `osascript ... choose folder`, Windows PowerShell `-STA` FolderBrowserDialog, 브라우저 열기 macOS `/usr/bin/open`·Windows `explorer.exe` — 모두 `execFile`(shell 없음). 사용자 취소 → `null`. 대화상자는 서버 옵션으로 주입 가능.
- `src/main.ts`: `npm start [-- --no-open]`. 터미널에 토큰 포함 주소를 출력하고(`--no-open`이 아니면 브라우저도 엶), Ctrl+C로 종료.
- `public/index.html`·`app.js`·`style.css`: 한국어, 빌드 없는 ES module. 상단 "읽기 전용: 파일을 이동·삭제하지 않습니다" 배너. 작업 폴더(대화상자 버튼 + 경로 입력) → 참고 폴더(선택/건너뛰기) → 분석(진행률·취소) → 미리보기(이동 제안/유지/검토, 중복 후보·남길 파일 제안·"논리 크기 — 확보량 아님", 큰 파일, 제외·오류) → 참고 규칙 후보(근거 파일 표시, 체크박스 → 확인 → 확인된 규칙으로 다시 미리보기). 토큰은 `location.hash`에서 읽어 `sessionStorage`에 두고 `history.replaceState`로 주소에서 지움. 데이터는 `textContent`로만 넣음(`innerHTML` 없음). 실제 `<button>`/`<label>`, 좁은 폭에서 줄바꿈. "실행" 버튼 없음.

ADR과 다른 점(작은 변형): 브라우저를 연 경우에도 터미널에 토큰 포함 주소를 출력합니다(열기 실패 시 복구용, 같은 사용자의 터미널). Linux 등 다른 OS는 브라우저를 열지 않고 주소만 출력하며 대화상자는 "경로를 직접 입력" 오류를 냅니다. 입력 경로는 어댑터가 절대 경로만 받습니다(아래 공용 코드 관찰).

## 실행한 명령과 결과 (macOS 27.0.1 arm64 실물 Mac, Node v24.18.0)

| 위치 | 명령 | 결과 |
| --- | --- | --- |
| `apps/desktop` | `npm install --ignore-scripts --no-audit --no-fund` | 4개 패키지, lockfile 생성(zod 4.6.7, typescript 5.9.3, @types/node 24.19.2) |
| `apps/desktop` | `npm run typecheck && npm test` | 오류 없음 / tests 16, pass 16, fail 0, skipped 0 |
| `apps/desktop` | 루트 `node_modules`를 잠시 치운 뒤 `rm -rf dist && npm test` | tests 16, pass 16 (자체 의존성만으로 빌드·실행) |
| 저장소 루트 | `npm run typecheck && npm test` | 오류 없음 / tests 144, pass 142, fail 0, skipped 2(실제 휴지통) — 기준 브랜치와 같은 구성 |
| `apps/desktop` | `node dist/apps/desktop/src/main.js --no-open`을 띄워 GET `/`·API 호출 후 SIGINT | GET 200 + ADR CSP, 틀린 토큰 401, 맞는 토큰 처리, 종료 코드 0 |

`test/server.test.ts`는 같은 프로세스에서 실제 서버를 `127.0.0.1`에 띄우고 `node:http.request`로 실제 HTTP를 보냅니다. fixture는 `tests/fixtures`의 `mkdtemp(os.tmpdir())` 합성 폴더만 씁니다. 검사 항목:
토큰 없음/틀림/다른 실행의 토큰/쿼리 토큰, Host 위조(7가지), 외부 Origin·`null`·`Sec-Fetch-Site: cross-site`, API의 GET/PUT/DELETE/PATCH/OPTIONS/HEAD, 잘못된 Content-Type, 큰 본문(선언·chunked), 잘못된 JSON, 알 수 없는 채널·필드, 모르는/위조 grant ID·서버 밖에서 발급한 grant·참고 grant를 작업 루트로·작업 grant를 참고로, 다시 고른 뒤 이전 grant 거부, 입력 경로 거부(상대 경로 — cwd 기준으로는 실제 허용 폴더인 경우 포함, `/`, 가짜 HOME, `/System`, 심볼릭 링크 루트, NUL, 파일, 없는 경로, `..`, 개발 프로젝트, 앱 묶음), 정적 경로 탐색(`/../package.json`, `/%2e%2e/package.json`, `/app.js/..` 등 16가지), HTML 보안 헤더·인라인 스크립트/스타일 없음·`innerHTML` 없음,
전체 흐름(작업+참고 폴더 선택 → 분석 → 폴링 → 미리보기·규칙 후보·보호 목록이 같은 fixture에 `analyzeRoot`를 직접 호출한 결과와 deepEqual → 규칙 확인 → 확인된 프로필로 재분석 결과도 직접 호출과 deepEqual, `PERSONAL_RULE` 이동 제안 확인), 참고 없이 분석 시 `NO_RULES`, 취소(작업을 취소 신호까지 붙잡은 뒤 실제 `analyzeRoot`를 중단 신호로 실행 → `cancelled`/`CANCELLED`), 예기치 못한 오류에 경로·스택이 없음, 선택 뒤 폴더가 바뀌면 `FILE_CHANGED`,
그리고 작업 폴더·참고 폴더의 전후 manifest(경로·크기·mtime·sha256)가 같음(아무것도 쓰지 않음).

추가 확인(일회성, 저장소 밖 scratchpad 스크립트): 컴파일된 서버의 각 방어(Host, Origin, 토큰, Content-Type, POST, 본문 한도, 정적 허용 목록, CSP 헤더, 절대 경로 검사, grant 재선택 무효화, strict 스키마, 오류 메시지 필터)를 하나씩 꺼 보면 테스트가 실패했습니다. "참고 grant를 작업 루트로" 검사만은 꺼도 공용 `verifyGrant`의 scope 검사가 같은 코드(`ROOT_FORBIDDEN`)로 막아 테스트가 통과합니다(이중 방어).

## 검증 수준

- Implemented + Unit-verified + 이 Mac의 실제 로컬 HTTP(127.0.0.1) 검사. 실제 temp 파일에 대한 읽기 전용 확인(Physical, 이 Mac).
- **실제 브라우저 렌더·클릭 검증은 하지 않았습니다**(coordinator 담당). `app.js`는 `node --check` 구문 검사만 했습니다. CSP 아래에서 화면이 실제로 동작하는지, 키보드 조작·좁은 폭 표시는 브라우저에서 확인해야 합니다.
- **OS 폴더 대화상자는 실행하지 않았습니다.** 테스트는 주입한 stub만 사용합니다. macOS `osascript`(대화상자가 브라우저 뒤에 뜨는지 포함)와 Windows PowerShell 대화상자는 실물 확인이 필요합니다.
- Windows: 미검증(CI·실물 없음). `explorer.exe`로 `#t=` fragment가 유지되는지, 종료 코드 처리도 미확인입니다.

## 공용 코드 관찰(수정하지 않음)

- `issueRootGrant`/`issueReferenceGrant`(`packages/filesystem/src/grants.ts` `checkRoot`)는 상대 경로를 프로세스 cwd 기준으로 해석해 허용합니다(`.`/`..` 조각만 거부). CLI에서는 의도된 동작일 수 있으나 GUI 입력에는 맞지 않아 어댑터가 절대 경로만 받습니다. 공용 정책에서 정할지는 core-builder와 결정이 필요합니다.
- `analyzeRoot`는 참고 폴더 스캔이 미완료면 일반 `Error`를 던집니다(AfoError 아님). 화면에는 메시지를 `UNKNOWN` 코드로 보여 줍니다. 공용 오류 코드로 바꾸면 화면 처리가 더 명확해집니다.

## 남은 일

승인·실행 화면(#8 `approvals.ts`, #10–#12 `executor.ts`가 main에 들어온 뒤), 규칙 저장·비활성화·초기화(#18 저장소), 규칙 수정의 이번만/이후 적용, 긴 경로·부분 실패 표시의 브라우저 확인, 두 OS 실물 GUI 경로 검증. #9 완료 조건 대부분은 아직 열려 있습니다.
