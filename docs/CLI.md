# AFO CLI 사용법과 종료 코드

이 문서는 `apps/cli/src/`(`index.ts`·`analyze.ts`·`rules.ts`·`plan.ts`)에 **구현된** 동작만 적습니다. 현재 CLI는 사용자 파일을 읽기만 합니다.
`plan`은 정리 계획을 만들어 상태 폴더에 저장하고 승인 코드를 보여 줄 뿐 실행하지 않습니다. 실행(`apply`)·되돌리기 명령은 #10 이후 추가되며 도움말에도 아직 없습니다.

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
- 변경 명령은 읽은 프로필의 revision을 `expectedRevision`으로 넘겨, 그 사이 다른 프로세스가 바꾼 프로필은 `PROFILE_CHANGED`로 거부합니다. 프로필이 비었거나 손상된 상태에서는 현재 저장 API로 revision을 고정할 수 없어 이 검사가 없습니다.
- 사람용 출력은 참고 폴더를 마지막 이름(라벨)으로만 표시합니다. 단, `suggest-rules`의 초안 JSON과 `preview --json`의 `suggestedProfile`·`preview.root`는 계약(v1 `ProfileSchema`, `PreviewSchema`)상 실제 절대 경로를 담습니다. `rules save`로 저장한 프로필에는 절대 경로가 남지 않습니다.

`plan` 옵션: `--reference`·`--profile`·`--no-saved-rules`·`--move`는 preview와 같습니다(`--move`는 이번 계획에만 적용, `--remember`는 쓸 수 없음).

| 옵션 | 뜻 |
| --- | --- |
| `--delete-mode trash\|permanent` | 삭제 작업의 방식. 기본 `trash`(OS 휴지통). `permanent`는 **되돌릴 수 없음**을 출력하고, 실행 때 승인 코드와 확인 문구 `영구 삭제`가 모두 필요하다고 안내 |
| `--delete-duplicates all\|<해시,...>` | 중복 후보를 삭제 작업에 넣음. 각 그룹의 남길 파일(keeper)은 작업에 넣지 않고 유지 항목으로 남김. 해시는 출력의 그룹 해시 앞 8자 이상(모호하면 `KEEPER_INVALID`) |
| `--delete-file <상대 경로>` | 직접 고른 파일 하나를 삭제 작업에 넣음(여러 번 가능, keeper 없음). 참고한 기존 파일은 거부(`ROOT_FORBIDDEN`). 내용이 같은 파일(해시가 같은 2개 이상)을 **모두** 고르면 "모든 사본이 삭제됩니다" 오류(`KEEPER_INVALID`, 종료 코드 1)로 거부하고 아무것도 저장하지 않음 |
| `--delete-last-copy` | 위의 경우에도 마지막 사본까지 지우는 것을 명시적으로 허용. `--delete-file` 없이 쓰면 사용법 오류(2). 그 작업의 이유에 마지막 사본 삭제임을 적고, 사람용 출력에 경고 줄을 냄. 중복이 아니거나 사본이 하나 남는 삭제에는 필요 없음 |
| `--json` | stdout에 JSON만: `{ planId, plan, approvalChoices, reviewItems }`. `plan`은 `OperationPlanSchema`, `approvalChoices`는 방식별 `{ mode, operationIds, code }` |

- 사람용 출력: 계획 ID, 만료 시각(생성 후 1시간), 개인 규칙 적용 상태, 삭제 방식, 방식별 작업 목록, 중복 후보 그룹(해시 앞 12자), 검토·유지 항목의 이유별 개수와 예시, 방식별 승인 코드, "실행 명령은 다음 버전에서 제공" 안내. 크기는 논리 크기이며 확보량이 아닙니다.
- 승인 코드는 그 방식의 작업 **전체**를 묶은 코드입니다(`approvalChoices`). 이 명령은 승인 기록을 만들지 않습니다.
- 같은 폴더를 다시 plan하면 상태 폴더의 `plans/latest-<루트ID>.json`(CLI가 쓰는 작은 인덱스, 계획 ID만 저장)으로 직전 계획을 찾아 `diffPlans`로 비교하고, **새로 추가·바뀐 작업과 빠진 작업만** 표시합니다. 작업 ID는 파일 식별·크기·수정 시각·목적지·keeper의 해시라 같은 ID는 이미 본 작업입니다. 프로필·삭제 방식 변경과 같은 경로의 폴더 교체도 알립니다. `--json`은 항상 전체 계획입니다. 직전 계획을 읽지 못하면 stderr에 알리고 전체를 표시합니다.
- 계획 ID는 생성 시각·세션·폴더 권한을 포함하므로 같은 입력이어도 실행마다 다릅니다. 파일이 같으면 작업 ID 집합은 같습니다.
- 계획은 저장된 개인 규칙의 ID·revision에 묶입니다. 저장 프로필과 다른 `--profile` 파일의 규칙이 적용된 계획은 저장하지 않습니다(`PROFILE_CHANGED`, 종료 코드 1). 그 규칙을 쓰려면 `rules save`로 저장한 뒤 plan 합니다.
- 상태 폴더가 작업·참고 폴더와 겹치면 아무것도 쓰기 전에 거부합니다(`STATE_DIR_CONFLICT`).
- plan은 분석(`analyzeRoot`)이 미리보기를 만든 바로 그 스캔(중복 해시 포함, `Analysis.scan`)으로 계획을 만듭니다. 두 번째 스캔·해시가 없어 분석과 계획 사이의 파일 변경 경쟁 창이 없습니다. 분석 이후의 파일 변경은 계획에 반영되지 않으며, 실행 직전 재검증(#10 이후 executor)에서 거부해야 합니다.
- 영구 삭제 확인 문구는 실행(승인) 때 NFC 정규화 후 `영구 삭제`와 비교합니다(조합형 NFD 입력도 같은 문구로 인정). 승인의 결합 대상과 위협 모델은 [ADR 0003](adr/0003-approval-binding.md)을 봅니다.

`npm run preview -- <폴더>`, `npm run rules:suggest -- <폴더>`, `npm run rules:confirm -- <JSON> --select <ID>`, `npm run afo -- rules list`도 같은 명령입니다.
JSON을 파일로 받을 때는 npm 배너가 섞이지 않도록 `node dist/apps/cli/src/index.js ...`를 직접 실행합니다.

## 종료 코드

| 코드 | 의미 | 예 |
| --- | --- | --- |
| 0 | 성공. 결과를 stdout에 출력 | `--help`, 정상 `preview`. **스캔이 일부 미완료여도 0**이며 출력의 "스캔 일부 미완료"와 JSON `scanComplete: false`로 구분합니다 |
| 1 | 입력 거부 또는 오류 | 없는 폴더, 홈·디스크 루트 같은 거부 대상, 손상된 규칙 JSON, 모르는 규칙/수정 ID, 손상 프로필 편집, `PROFILE_CHANGED`, plan의 모르는 중복 그룹·keeper 오류·`--delete-last-copy` 없이 모든 사본 선택(`KEEPER_INVALID`)·없는 파일(`SOURCE_MISSING`)·참고 파일 삭제(`ROOT_FORBIDDEN`)·`STATE_DIR_CONFLICT` |
| 2 | 사용법 오류. 아무것도 바꾸지 않음 | 모르는 명령·옵션(`--execute` 등), 명령에 맞지 않는 옵션, 인수 개수, `--select` 없음·빈 선택, `--move` 형식, 비TTY `rules reset`에 `--confirm` 없음, plan의 `--delete-mode` 값·`--delete-duplicates` 형식·`--remember`·`--delete-file` 없는 `--delete-last-copy` |
| 4 | 확인(승인) 거부·무효 | TTY `rules reset` 질문에 y가 아닌 답, `--confirm` 값 불일치. 후속 승인 오류(`APPROVAL_*`·`PLAN_CHANGED`·`MODE_MISMATCH`)도 4 |
| 130 | Ctrl+C(SIGINT)로 취소 | 큰 폴더 스캔 중 중단, 확인 질문 중 중단 |

코드 3(일부 실패/unknown)은 실행 명령(#10 이후)에서 씁니다. 지금은 반환하지 않습니다.
오류는 stderr에 `AFO 오류[코드]: 메시지`(공용 `AfoError`) 또는 `AFO 오류: 메시지`(그 밖) 한 줄로 출력합니다.

검증: `tests/cli.test.ts`(0·1·2와 오류 형식)와 `tests/cli-rules.test.ts`(제안→저장→자동 적용→재시작→켜기/끄기→이번만/저장 수정→forget→reset·손상 프로필, 0·1·2·4)가 실제 자식 프로세스와 temp `AFO_STATE_DIR`로 확인합니다.
`tests/cli-plan.test.ts`는 plan의 저장 파일·`loadSavedPlan` 결과와 출력 일치, 승인 코드 재계산, 두 번 실행의 같은 작업 ID 집합, 파일 하나 변경 뒤 바뀐 작업만 표시, 중복 그룹 keeper 유지, 참고 파일 비포함, 영구 삭제 문구, 순수 JSON stdout, 저장 프로필 결합, 마지막 사본 거부(1)·`--delete-last-copy` 허용·플래그 단독(2), 0·1·2 거부와 작업·참고 폴더 manifest 불변을 자식 프로세스로 확인합니다. plan이 따로 스캔·해시하지 않는 것은 컴파일된 `plan.js`의 정적 검사와 `tests/approvals.test.ts`의 `Analysis.scan` 테스트로만 확인합니다(프로세스 수준 I/O 계측 없음).
TTY 질문은 자식 프로세스에 pty가 없어 `run()`에 응답 함수를 넣는 프로세스 내 테스트로만 확인합니다. 130과 `PROFILE_CHANGED` 경쟁은 CLI 자동 테스트가 없습니다(미검증, 저장 API의 거부 자체는 `tests/profiles.test.ts`).
