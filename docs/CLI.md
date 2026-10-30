# AFO CLI 사용법과 종료 코드

이 문서는 `apps/cli/src/`(`index.ts`·`analyze.ts`·`rules.ts`·`plan.ts`·`apply.ts`)에 **구현된** 동작만 적습니다.
사용자 파일을 옮기거나 지우는 명령은 `apply`와 `undo`뿐입니다. 둘 다 확인 코드를 직접 입력해야 하고, 실제 파일 변경은 공용 실행 서비스(`packages/filesystem/src/approvals.ts`·`executor.ts`)만 합니다. 나머지 명령은 사용자 파일을 읽기만 합니다.

## 명령

먼저 `npm run build`가 필요합니다. 설치·검사 방법은 [DEVELOPMENT.md](DEVELOPMENT.md)를 봅니다. 아래 `...`은 `node dist/apps/cli/src/index.js`입니다.

| 명령 | 하는 일 | 쓰는 곳 |
| --- | --- | --- |
| `... --help` (인수 없음도 같음) | 도움말 | 없음 |
| `... preview <폴더> [옵션]` | 스캔·분류·중복 후보·미리보기 출력. **저장된 개인 규칙을 자동 적용** | 없음(`--remember`일 때만 상태 폴더) |
| `... plan <폴더> [옵션]` | preview와 같은 분석 → 정리 계획(작업 ID·종류·원본→목적지·이유, 삭제는 남길 파일과 논리 크기) → 상태 폴더에 저장 → 방식별 승인 코드 출력. 승인을 발급하거나 파일을 바꾸지 않음 | 상태 폴더(`plans/`) |
| `... suggest-rules <참고 폴더> [--json]` | 참고 폴더의 이름·확장자만 읽어 규칙 후보(draft) JSON을 stdout에, 한국어 요약을 stderr에 출력. `--json`이면 요약 생략 | 없음(초안 파일 저장은 사용자의 셸 리디렉션) |
| `... rules save <초안 JSON> --select <ID,...>` | 고른 규칙만 확인(confirmed)해 앱 로컬 프로필로 저장. 빈 선택·모르는 ID 거부. 기존 프로필의 규칙은 대체하고 **저장한 수정은 유지** | 상태 폴더 |
| `... rules list [--json]` | 저장 프로필: ID·revision·켜짐/꺼짐·참고 폴더 이름, 규칙별 근거 예시·목적지·켜짐 여부, 저장한 수정. 없음·손상도 안내(종료 코드 0) | 없음 |
| `... rules enable\|disable <규칙ID>` | 저장 규칙 하나를 켜기/끄기 | 상태 폴더 |
| `... rules enable-all\|disable-all` | 프로필 전체 켜기/끄기. 꺼진 동안 기본 분류, 참고 파일 보호는 유지 | 상태 폴더 |
| `... rules forget <수정ID>` | `--remember`로 저장한 수정 하나 지우기 | 상태 폴더 |
| `... rules reset [--confirm reset]` | 저장 규칙·수정을 모두 잊기. TTY면 `[y/N]` 질문, 비TTY면 `--confirm reset` 필수 | 상태 폴더 |
| `... confirm-rules <규칙 JSON> --select <ID,ID>` | (이전 방식) 고른 규칙만 `confirmed`로 바꾼 JSON 출력. 저장하지 않음 | 없음 |
| `... apply <계획 ID> --mode organize\|trash\|permanent-delete [옵션]` | 저장된 계획의 한 방식 작업을 보여 주고 승인 코드(영구 삭제는 문구도)를 확인한 뒤 `issueApproval` → `consumeApproval` → `executeBatch`로 **실제 실행** | 작업 폴더(이동·휴지통·영구 삭제), 상태 폴더(`approvals/`·`runs/`·`journal/`·`locks/`) |
| `... undo <실행 ID> [--confirm <코드>] [--json]` | 이동(organize) 실행만 원래 위치로 되돌림(`undoRun`). 확인 코드는 실행 ID 앞 8자 | 작업 폴더(역이동), 상태 폴더 |
| `... runs [<실행 ID>] [--json]` | 실행 기록 요약(시각·방식·결과 수·되돌리기 횟수·undo 가능 여부) 또는 한 실행의 항목별 결과와 되돌리기 기록 | 없음 |
| `... recover [--json]` | `inspectRuns`로 끝나지 않은 실행·결과 불명 항목과 해제 조건을 보고. 자동 재실행·원복·삭제 없음 | 없음 |
| `... gui [<폴더>] [--port <번호>] [--no-open]` | 이 컴퓨터에서만 열리는 브라우저 화면(아래 "화면으로 보기")으로 미리보기·계획·규칙·실행 기록·복구 점검을 봄. 실행(apply·undo)은 하지 않음 | 상태 폴더(`plans/`, 화면에서 계획을 만들 때만) |

`preview` 옵션:

| 옵션 | 뜻 |
| --- | --- |
| `--reference <참고 폴더>` | 참고 폴더를 읽어 그 안의 기존 파일을 보호하고 규칙 후보를 함께 보여 줌(저장·적용하지 않음) |
| `--profile <JSON>` | 저장 프로필 대신 v1/v2 프로필 파일을 적용 |
| `--no-saved-rules` | 저장 프로필을 쓰지 않고 기본 분류 |
| `--move <상대 경로>=<목적지 폴더>` | 이번 미리보기에만 적용하는 사용자 수정(여러 번 가능). 목적지는 작업 폴더 기준 상대 폴더(숨김·`..`·절대 경로 불가) |
| `--remember` | `--move`의 수정을 파일 이름 조건으로 "이후에도 적용" 저장하고 그 사실과 수정 ID를 출력. 미리보기가 성공한 뒤에만 저장 |
| `--json` | stdout에 JSON만: `{ preview, suggestedProfile, profile: { source, id, revision, status, warning? }, remembered? }` |

- 저장 프로필이 손상됐으면 `preview`는 stderr에 경고를 내고 기본 분류로 계속합니다(종료 코드 0, JSON `profile.source: "corrupt"`). 규칙 편집과 `--remember`는 거부합니다. `rules reset`·`rules save`는 손상 파일을 지우지 않고 `corrupt-*.json`으로 옮긴 뒤 진행합니다.
- 상태 폴더는 `AFO_STATE_DIR`(절대 경로)를 따르고, 없으면 OS 앱 데이터 폴더입니다. `--remember`는 상태 폴더가 작업·참고 폴더와 겹치면 거부합니다(`STATE_DIR_CONFLICT`).
- 저장한 참고 폴더의 이름·위치가 바뀌었거나 근거 파일이 다른 폴더에서 발견되면(`preview.profileNotice.code: "PROFILE_STALE"`) 저장 프로필을 이번 분석에 적용하지 않습니다. 사람용 출력은 `개인 규칙: 저장된 프로필(revision N) — 이번 분석에는 적용하지 않음(참고 폴더 변경 감지, …)`과 `경고:` 한 줄, JSON은 `profile.source: "stale"`(`id`·`revision`은 저장된 프로필의 값, `preview.profileId`는 `null`)입니다. 저장소에는 쓰지 않습니다.
- 변경 명령은 읽은 상태를 고정해 넘깁니다: 활성 프로필은 `expectedRevision: <revision>`, 빈 저장소는 `expectedRevision: null`, 손상 파일은 `expectedCorrupt: <fingerprint>`. 그 사이 다른 프로세스가 바꿨으면 `PROFILE_CHANGED`로 거부합니다. 검사와 쓰기는 상태 폴더 `locks/`의 프로필 잠금 안에서 함께 실행되며, 다른 실행이 잠금을 가진 동안 약 3초 기다린 뒤에도 풀리지 않으면 `LOCKED_BY_OTHER`(종료 코드 1)입니다.
- 사람용 출력은 참고 폴더를 마지막 이름(라벨)으로만 표시합니다. 단, `suggest-rules`의 초안 JSON과 `preview --json`의 `suggestedProfile`·`preview.root`는 계약(v1 `ProfileSchema`, `PreviewSchema`)상 실제 절대 경로를 담습니다. `rules save`로 저장한 프로필에는 절대 경로가 남지 않습니다.

`plan` 옵션: `--reference`·`--profile`·`--no-saved-rules`·`--move`는 preview와 같습니다(`--move`는 이번 계획에만 적용, `--remember`는 쓸 수 없음).

| 옵션 | 뜻 |
| --- | --- |
| `--delete-mode trash\|permanent` | 삭제 작업의 방식. 기본 `trash`(OS 휴지통). `permanent`는 **되돌릴 수 없음**을 출력하고, 실행 때 승인 코드와 확인 문구 `영구 삭제`가 모두 필요하다고 안내 |
| `--delete-duplicates all\|<해시,...>` | 중복 후보를 삭제 작업에 넣음. 각 그룹의 남길 파일(keeper)은 작업에 넣지 않고 유지 항목으로 남김. 해시는 출력의 그룹 해시 앞 8자 이상(모호하면 `KEEPER_INVALID`) |
| `--delete-file <상대 경로>` | 직접 고른 파일 하나를 삭제 작업에 넣음(여러 번 가능, keeper 없음). 참고한 기존 파일은 거부(`ROOT_FORBIDDEN`). 내용이 같은 파일(해시가 같은 2개 이상)을 **모두** 고르면 "모든 사본이 삭제됩니다" 오류(`KEEPER_INVALID`, 종료 코드 1)로 거부하고 아무것도 저장하지 않음 |
| `--delete-last-copy` | 위의 경우에도 마지막 사본까지 지우는 것을 명시적으로 허용. `--delete-file` 없이 쓰면 사용법 오류(2). 그 작업의 이유에 마지막 사본 삭제임을 적고, 사람용 출력에 경고 줄을 냄. 중복이 아니거나 사본이 하나 남는 삭제에는 필요 없음 |
| `--json` | stdout에 JSON만: `{ planId, plan, approvalChoices, reviewItems }`. `plan`은 `OperationPlanSchema`, `approvalChoices`는 방식별 `{ mode, operationIds, code }` |

- 사람용 출력: 계획 ID, 만료 시각(생성 후 1시간), 개인 규칙 적용 상태, 삭제 방식, 방식별 작업 목록, 중복 후보 그룹(해시 앞 12자), 검토·유지 항목의 이유별 개수와 예시, 방식별 승인 코드, `apply <계획 ID> --mode <방식>` 실행 안내. 크기는 논리 크기이며 확보량이 아닙니다.
- 승인 코드는 그 방식의 작업 **전체**를 묶은 코드입니다(`approvalChoices`). 이 명령은 승인 기록을 만들지 않습니다(승인은 `apply`가 발급·소비).
- 같은 폴더를 다시 plan하면 상태 폴더의 `plans/latest-<루트ID>.json`(CLI가 쓰는 작은 인덱스, 계획 ID만 저장)으로 직전 계획을 찾아 `diffPlans`로 비교하고, **새로 추가·바뀐 작업과 빠진 작업만** 표시합니다. 작업 ID는 파일 식별·크기·수정 시각·목적지·keeper의 해시라 같은 ID는 이미 본 작업입니다. 프로필·삭제 방식 변경과 같은 경로의 폴더 교체도 알립니다. `--json`은 항상 전체 계획입니다. 직전 계획을 읽지 못하면 stderr에 알리고 전체를 표시합니다.
- 계획 ID는 생성 시각·세션·폴더 권한을 포함하므로 같은 입력이어도 실행마다 다릅니다. 파일이 같으면 작업 ID 집합은 같습니다.
- 계획은 저장된 개인 규칙의 ID·revision에 묶입니다. 저장 프로필과 다른 `--profile` 파일의 규칙이 적용된 계획은 저장하지 않습니다(`PROFILE_CHANGED`, 종료 코드 1). 그 규칙을 쓰려면 `rules save`로 저장한 뒤 plan 합니다.
- 상태 폴더가 작업·참고 폴더와 겹치면 아무것도 쓰기 전에 거부합니다(`STATE_DIR_CONFLICT`).
- plan은 분석(`analyzeRoot`)이 미리보기를 만든 바로 그 스캔(중복 해시 포함, `Analysis.scan`)으로 계획을 만듭니다. 두 번째 스캔·해시가 없어 분석과 계획 사이의 파일 변경 경쟁 창이 없습니다. 분석 이후의 파일 변경은 계획에 반영되지 않으며, apply의 실행 직전 재검증(executor)에서 해당 항목을 거부합니다.
- 영구 삭제 확인 문구는 실행(승인) 때 NFC 정규화 후 `영구 삭제`와 비교합니다(조합형 NFD 입력도 같은 문구로 인정). 승인의 결합 대상과 위협 모델은 [ADR 0003](adr/0003-approval-binding.md)을 봅니다.

## 실행: apply

`apply <계획 ID> --mode organize|trash|permanent-delete [--only <작업ID,...>] [--confirm <승인 코드>] [--phrase <확인 문구>] [--json]`

| 옵션 | 뜻 |
| --- | --- |
| `--mode` (필수) | 한 번에 한 방식만: `organize`(이동 작업), `trash`(휴지통 작업), `permanent-delete`(영구 삭제 작업). 계획에 그 방식의 작업이 없으면 `MODE_MISMATCH`(4) |
| `--only <작업ID,...>` | 그 방식 작업 중 일부만. 다른 종류·모르는·중복 ID는 거부(4). 부분 선택의 승인 코드는 plan의 코드와 다르며 apply의 확인 요약(stderr)에 표시됩니다 |
| `--confirm <승인 코드>` | 확인 요약에 나온 8자 코드. **TTY가 아니면 필수**이고 없으면 종료 코드 4로 거부하며 승인을 발급하지 않습니다. TTY면 생략 시 입력을 받습니다(빈 입력은 거부 4) |
| `--phrase <확인 문구>` | `permanent-delete`에서만(다른 방식에 쓰면 2). 정확히 `영구 삭제`(NFC 비교). TTY가 아니면 필수, TTY면 생략 시 입력을 받습니다 |
| `--json` | stdout에 JSON만: `{ runId, report }`(`report`는 `ExecutionReportSchema`). 확인 요약은 입력·옵션이 필요할 때만 stderr에 출력 |

- 순서: `loadSavedPlan`으로 저장 계획을 읽고 → 선택 작업·이유·남길 파일(keeper)·논리 크기("확보량 아님")·영구 삭제면 "되돌릴 수 없음"과 승인 코드를 stderr에 표시 → 코드(와 문구) 확인 → `issueApproval` → `consumeApproval` → `executeBatch`(루트 잠금 안에서 작업마다 저널 선기록·실행 직전 재검증·독립 확인).
- 승인 코드는 `approvalCode(계획 ID, 정렬된 작업 ID, 방식)`입니다. 틀린 코드·다른 방식의 코드·만료된 계획은 서비스가 거부합니다(4, 파일·승인 기록 변경 없음). 계획 뒤 개인 규칙이 바뀌면 `PROFILE_CHANGED`(1), 계약에 맞지 않게 손상·변조된 계획 파일은 `STATE_CORRUPT`(1)로 거부하며 역시 아무것도 바꾸지 않습니다. 계약에는 맞지만 내용 해시가 맞지 않는 계획은 `PLAN_CHANGED`(4)입니다. `--yes` 같은 불리언 동의 옵션은 없습니다(2).
- **같은 작업은 이 CLI로 두 번 실행하지 않습니다.** 같은 계획의 실행 기록(`runs/`)에 고른 작업 ID가 하나라도 있으면 새 승인을 발급하지 않고 `APPROVAL_USED`(4)로 거부합니다. 실행 기록을 읽을 수 없으면 실행하지 않습니다(`STATE_CORRUPT`, 1). 다시 정리하려면 plan부터 다시 합니다. 한 승인 기록의 재사용은 서비스(`approvals/<id>.used`, `runs/<id>.approval`)가 막습니다.
- 사람용 결과(stdout): 실행 ID, 항목별 결과(`이동함`/`휴지통으로 보냄`/`영구 삭제함`/`건너뜀`/`실패`/`결과 불명`과 오류 코드·이유), 개수, 논리 크기 합계(확보량 아님), 영구 삭제만 관측한 여유 공간 전후(다른 프로그램 영향 가능), 서비스의 공간 설명, 되돌리기 안내(이동만 `undo <실행 ID>`, 휴지통은 OS 휴지통에서 사용자가 복원, 영구 삭제는 되돌릴 수 없음).
- 실행 직전 재검증: plan 이후 바뀐 원본은 `FILE_CHANGED`/`SOURCE_MISSING`으로 실패, 목적지에 이미 파일이 있으면 `DEST_EXISTS`로 실패(덮어쓰지 않음), 다른 항목은 계속 처리합니다(종료 코드 3).
- 다른 실행이 같은 작업 폴더의 잠금을 갖고 있으면 `LOCKED_BY_OTHER`(1). 파일·실행 기록은 바뀌지 않지만 이번 승인은 이미 소비됐으므로, 다른 실행이 끝난 뒤 apply를 다시 실행해 승인을 다시 받아야 합니다. 잠금은 상태 폴더 안에 있어 `AFO_STATE_DIR`가 다른 두 실행은 서로 막지 못합니다(#10 R2-1).
- 실행은 끝났지만 잠금을 풀지 못한 경우(메시지 "작업은 끝났지만", 1)와 결과 파일을 저장하지 못한 경우(1, 결과는 출력하고 저널에 남음)는 같은 apply를 다시 실행하지 말고 `runs <실행 ID>`·`recover`로 확인하라고 안내합니다.

## 되돌리기·기록·복구

- `undo <실행 ID> [--confirm <실행 ID 앞 8자>] [--json]`: `readRun`으로 되돌릴 후보(이동했고 아직 되돌리지 않은 항목, 정리한 위치 → 원래 위치)를 stderr에 보여 주고 확인 코드를 TTY 입력 또는 `--confirm`으로 받습니다(비TTY에서 없거나 틀리면 4). 그 뒤 원래 폴더 권한을 다시 발급해 `undoRun`을 호출합니다. 원래 경로가 차 있거나(`DEST_EXISTS`) 정리한 파일이 바뀐(`FILE_CHANGED`) 항목은 `되돌리지 않음`으로 표시하고 덮어쓰지 않습니다(종료 코드 3). 결과가 확인되지 않은 항목은 추측해 옮기지 않고 `결과 불명`으로 보고합니다. 휴지통·영구 삭제 실행은 되돌리지 않습니다(1, 휴지통은 OS에서 사용자가 복원). 되돌릴 항목이 없으면 확인 없이 0. 이동하면서 만든 빈 폴더는 지우지 않습니다. `--json`: `{ runId, report }`.
- `runs [--json]`: `listRuns`/`readRun`의 요약을 시작 시각 순으로. JSON `{ runs: [{ runId, planId, mode, startedAt, finishedAt, results, undos, undone, undoable }] }`(`results`는 상태별 개수, 끝나지 않은 실행은 `null`; 읽을 수 없는 기록은 `{ runId, error }`). `runs <실행 ID> [--json]`: 항목별 결과·공간 설명·되돌리기 회차별 결과, JSON은 `{ run, undos }`. 없는 실행 ID는 1, 형식이 아니면 2.
- `recover [--json]`: `inspectRuns(상태 폴더, { loadPlan: loadSavedPlan })`. `clean`이 아닌 실행만 보고합니다(상태 `active`/`unfinished`/`corrupt`/`unreadable`, 문제, 끝나지 않은 작업의 관측 상태와 해제 조건·할 일). JSON `{ checked, runs }`. 확인이 필요한 실행이 있으면 3, 없거나 진행 중(`active`)뿐이면 0. 파일·상태 폴더를 바꾸지 않습니다.

## 화면으로 보기 (gui)

`gui [<폴더>] [--port <번호>] [--no-open]`(`npm run gui -- <폴더>`와 같음, 구현: `apps/cli/src/gui.ts`·`gui-assets.ts`)

- `127.0.0.1`의 빈 포트(또는 `--port`, 1024–65535)에 작은 HTTP 서버를 띄우고 stderr에 `AFO GUI: http://127.0.0.1:<포트>/#token=<무작위 48자>`를 출력한 뒤 기본 브라우저로 엽니다(`--no-open`이면 열지 않음). Ctrl+C로 끝내면 종료 코드 0입니다.
- 폴더를 주면 화면이 열리자마자 그 폴더를 분석합니다. 화면의 폴더 입력은 절대 경로만 받습니다. 홈·디스크 루트 같은 거부 대상은 CLI와 같은 오류로 표시합니다.
- 화면: **미리보기**(개수 요약, 목적지 폴더별 묶음, 파일별 제안 검색·거르기, 중복 후보, 제외·오류), **정리 계획**(삭제 방식·중복 포함 선택 → 계획 저장, 방식별 작업·승인 코드·복사할 `apply` 명령), **개인 규칙**(저장 프로필·규칙·저장한 수정, 읽기만), **실행 기록**(실행별 결과와 파일 이름, 이동이면 `undo` 명령), **복구 점검**(`recover`와 같은 보고).
- 공용 함수를 그대로 씁니다: 미리보기는 `analyzeTarget`, 계획은 `createPlan`(CLI `plan`과 같은 함수, 같은 `plans/latest-<루트ID>.json` 인덱스 갱신), 기록은 `runSummaries`·`readRun`, 복구는 `recoverReport`(`inspectRuns`), 규칙은 `loadProfile`. CLI 출력을 파싱하지 않습니다.
- **실행하지 않습니다.** apply·undo·규칙 변경 API가 없습니다. 화면은 승인 코드와 `apply <계획 ID> --mode <방식>` 명령을 보여 주고, 사용자가 터미널에서 실행하면 CLI가 작업 목록을 다시 보여 주고 승인 코드(영구 삭제는 문구도)를 묻습니다.
- 요청 검사: API는 매 요청의 `x-afo-token`(시작할 때 만든 무작위 값, 상수 시간 비교), `Host`가 `127.0.0.1:<포트>` 또는 `localhost:<포트>`인지, `Origin`이 있으면 같은 주소인지 확인하고 아니면 403입니다. 페이지 자체도 `Host`를 확인합니다(DNS rebinding 방지). POST는 `application/json`·64 KiB 이하·정해진 필드만 받습니다. 토큰은 URL의 `#` 뒤에 있어 서버 로그·Referer로 가지 않습니다.
- 페이지는 strict CSP(`default-src 'none'; script-src 'self'` 등)로 제공하고, 파일 이름은 모두 `textContent`로 넣습니다(폴더 안 이름은 신뢰하지 않는 입력).
- 분석·계획은 한 번에 하나만 실행합니다(진행 중이면 409). 브라우저가 요청을 끊거나 GUI를 끝내면 진행 중인 분석을 취소합니다.
- 한계: 같은 컴퓨터의 다른 사용자·프로세스가 토큰을 알면 이 화면과 같은 읽기·계획 저장을 할 수 있습니다(파일 실행은 없음). 표는 항목을 최대 500개까지 표시하고 나머지는 검색으로 좁힙니다. Windows 실물에서는 아직 확인하지 않았습니다.

검증: `tests/gui.test.ts`가 실제 `gui` 자식 프로세스(`--no-open`, temp `AFO_STATE_DIR`)로 CSP·정적 경로, 토큰 없음·틀림·다른 Host·다른 Origin·JSON 아님·상대 경로·모르는 필드 거부, apply/undo API 부재, 미리보기 결과가 `preview --json`과 같고 작업·상태 폴더가 바뀌지 않음, 계획 저장 내용·승인 코드 일치, GUI 계획 → CLI apply 뒤 실행 기록·파일 이름·recover 표시, Ctrl+C 종료 코드 0(Windows 제외), 사용법 오류 2를 확인합니다. 클릭 흐름은 [검증 기록](verification/ISSUE_9_GUI.md)에 있습니다.

## 안전 규칙

- 확인 없이 실행하는 경로가 없습니다. 비TTY 실행은 `--confirm`(영구 삭제는 `--phrase`도)이 없으면 거부하고 아무것도 바꾸지 않습니다. 코드는 계획 ID·작업 목록·방식에 묶여 다른 선택·방식에 쓸 수 없습니다.
- CLI는 승인 기록을 만들거나 파일을 직접 바꾸지 않습니다. 승인 발급·소비·실행·되돌리기는 공용 서비스 함수만 호출하며, 그 서비스가 루트 경계·링크·덮어쓰기 금지·실행 직전 재검증·저널 선기록·루트 잠금을 강제합니다.
- 휴지통 실패를 영구 삭제로 우회하지 않습니다. 휴지통 비우기 명령은 없습니다. 실패·결과 불명 항목을 자동으로 다시 실행·원복·삭제하지 않습니다.

`npm run preview -- <폴더>`, `npm run rules:suggest -- <폴더>`, `npm run rules:confirm -- <JSON> --select <ID>`, `npm run afo -- rules list`도 같은 명령입니다.
JSON을 파일로 받을 때는 npm 배너가 섞이지 않도록 `node dist/apps/cli/src/index.js ...`를 직접 실행합니다.

## 종료 코드

| 코드 | 의미 | 예 |
| --- | --- | --- |
| 0 | 성공. 결과를 stdout에 출력 | `--help`, 정상 `preview`. **스캔이 일부 미완료여도 0**이며 출력의 "스캔 일부 미완료"와 JSON `scanComplete: false`로 구분합니다 |
| 1 | 입력 거부 또는 오류 | 실행 잠금 `LOCKED_BY_OTHER`(apply·undo), 잠금 해제·결과 저장 실패, 없는 실행 ID, 휴지통·영구 삭제 실행의 undo, 없는 폴더, 홈·디스크 루트 같은 거부 대상, 손상된 규칙 JSON, 모르는 규칙/수정 ID, 손상 프로필 편집, `PROFILE_CHANGED`, plan의 모르는 중복 그룹·keeper 오류·`--delete-last-copy` 없이 모든 사본 선택(`KEEPER_INVALID`)·없는 파일(`SOURCE_MISSING`)·참고 파일 삭제(`ROOT_FORBIDDEN`)·`STATE_DIR_CONFLICT`, 프로필 잠금 대기 초과 `LOCKED_BY_OTHER` |
| 2 | 사용법 오류. 아무것도 바꾸지 않음 | 모르는 명령·옵션(`--execute`·`--yes` 등), apply의 `--mode` 없음·잘못된 값, 64자가 아닌 계획 ID, 실행 ID 형식 아님, organize/trash에 `--phrase`, 명령에 맞지 않는 옵션, 인수 개수, `--select` 없음·빈 선택, `--move` 형식, 비TTY `rules reset`에 `--confirm` 없음, plan의 `--delete-mode` 값·`--delete-duplicates` 형식·`--remember`·`--delete-file` 없는 `--delete-last-copy` |
| 3 | 일부 실패·결과 불명 | apply·undo에서 하나라도 `moved/trashed/deleted`(undo는 되돌림)가 아닌 항목, recover에서 확인이 필요한 실행. 결과는 stdout에 출력 |
| 4 | 확인(승인) 거부·무효. 아무것도 바꾸지 않음 | 비TTY apply·undo에 `--confirm` 없음, 영구 삭제에 `--phrase` 없음·불일치, 틀린 코드·다른 방식의 코드, 이미 실행한 작업(`APPROVAL_USED`), 만료(`APPROVAL_EXPIRED`), 없는 계획·바뀐 계획(`PLAN_CHANGED`), `MODE_MISMATCH`, TTY 빈 입력, TTY `rules reset` 질문에 y가 아닌 답, `--confirm` 값 불일치 |
| 130 | Ctrl+C(SIGINT)로 취소 | 큰 폴더 스캔 중 중단, 확인 질문 중 중단, apply·undo 실행 중 중단(남은 항목은 `CANCELLED`로 건너뜀, 결과 출력) |
오류는 stderr에 `AFO 오류[코드]: 메시지`(공용 `AfoError`) 또는 `AFO 오류: 메시지`(그 밖) 한 줄로 출력합니다.

검증: `tests/cli.test.ts`(0·1·2와 오류 형식)와 `tests/cli-rules.test.ts`(제안→저장→자동 적용→재시작→켜기/끄기→이번만/저장 수정→forget→reset·손상 프로필, 0·1·2·4)가 실제 자식 프로세스와 temp `AFO_STATE_DIR`로 확인합니다.
`tests/cli-plan.test.ts`는 plan의 저장 파일·`loadSavedPlan` 결과와 출력 일치, 승인 코드 재계산, 두 번 실행의 같은 작업 ID 집합, 파일 하나 변경 뒤 바뀐 작업만 표시, 중복 그룹 keeper 유지, 참고 파일 비포함, 영구 삭제 문구, 순수 JSON stdout, 저장 프로필 결합, 마지막 사본 거부(1)·`--delete-last-copy` 허용·플래그 단독(2), 0·1·2 거부와 작업·참고 폴더 manifest 불변을 자식 프로세스로 확인합니다. plan이 따로 스캔·해시하지 않는 것은 컴파일된 `plan.js`의 정적 검사와 `tests/approvals.test.ts`의 `Analysis.scan` 테스트로만 확인합니다(프로세스 수준 I/O 계측 없음).
`tests/cli-apply.test.ts`는 자식 프로세스·합성 폴더·temp `AFO_STATE_DIR`로 plan → apply organize(비TTY `--confirm`) → 독립 manifest(목적지 sha256 일치·원래 경로 부재·다른 파일 불변) → runs → recover(빈 결과) → undo(원래 경로·해시·수정 시각 동일), `--confirm` 없음·틀린 코드·다른 방식 코드·`--yes`·잘못된 `--only` → 4/2와 무변경·승인 기록 없음, 같은 코드·포함 작업 재실행 → 4, `--only` 부분 실행, plan 이후 원본 수정(`FILE_CHANGED`)·목적지 선점(`DEST_EXISTS`, 덮어쓰지 않음) → 3과 나머지 처리, 영구 삭제 문구 없음 → 4·있으면 후보만 삭제하고 keeper 해시 유지·undo 거부(1), 테스트가 잡은 루트 잠금 → 1과 무변경·이후 재승인 실행, 두 자식 프로세스 동시 apply → 하나는 `LOCKED_BY_OTHER`(1), TTY 입력(프로세스 내 `runCli`)을 확인합니다. 실제 OS 휴지통은 `AFO_REAL_TRASH_TEST=1`일 때만 `afo-test-` 합성 파일 1개로 확인합니다(휴지통을 비우거나 읽지 않음). 실행 중 Ctrl+C(130)와 잠금 해제 실패·결과 저장 실패 안내는 CLI 자동 테스트가 없습니다(미검증). Windows는 미검증(CI 대기)입니다.
TTY 질문은 자식 프로세스에 pty가 없어 `run()`에 응답 함수를 넣는 프로세스 내 테스트로만 확인합니다. 130과 `PROFILE_CHANGED` 경쟁은 CLI 자동 테스트가 없습니다(미검증). 저장 API의 거부는 `tests/profiles.test.ts`, 두 프로세스 동시 저장·reset 경쟁은 `tests/verify-18-recheck.test.ts`(R18-20~22, 저장 API 직접 호출)에서 확인합니다.
