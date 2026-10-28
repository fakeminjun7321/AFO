# AFO CLI 사용법과 종료 코드

이 문서는 `apps/cli/src/index.ts`·`apps/cli/src/rules.ts`에 **구현된** 동작만 적습니다. 현재 CLI는 사용자 파일을 읽기만 합니다.
파일 이동·휴지통·영구 삭제(plan/apply) 명령은 #8·#10 이후 추가되며 도움말에도 아직 없습니다.

## 명령

먼저 `npm run build`가 필요합니다. 설치·검사 방법은 [DEVELOPMENT.md](DEVELOPMENT.md)를 봅니다. 아래 `...`은 `node dist/apps/cli/src/index.js`입니다.

| 명령 | 하는 일 | 쓰는 곳 |
| --- | --- | --- |
| `... --help` (인수 없음도 같음) | 도움말 | 없음 |
| `... preview <폴더> [옵션]` | 스캔·분류·중복 후보·미리보기 출력. **저장된 개인 규칙을 자동 적용** | 없음(`--remember`일 때만 상태 폴더) |
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
- 저장한 참고 폴더의 이름·위치가 바뀌었거나 근거 파일이 다른 폴더에서 발견되면(`preview.profileNotice.code: "PROFILE_STALE"`) 저장 프로필을 이번 분석에 적용하지 않습니다. 사람용 출력은 `개인 규칙: 저장된 프로필(revision N) — 이번 분석에는 적용하지 않음(참고 폴더 변경 감지, …)`과 `경고:` 한 줄, JSON은 `profile.source: "stale"`(`id`·`revision`은 저장된 프로필의 값, `preview.profileId`는 `null`)입니다. 저장소에는 쓰지 않습니다.
- 변경 명령은 읽은 상태를 고정해 넘깁니다: 활성 프로필은 `expectedRevision: <revision>`, 빈 저장소는 `expectedRevision: null`, 손상 파일은 `expectedCorrupt: <fingerprint>`. 그 사이 다른 프로세스가 바꿨으면 `PROFILE_CHANGED`로 거부합니다. 검사와 쓰기는 상태 폴더 `locks/`의 프로필 잠금 안에서 함께 실행되며, 다른 실행이 잠금을 가진 동안 약 3초 기다린 뒤에도 풀리지 않으면 `LOCKED_BY_OTHER`(종료 코드 1)입니다.
- 사람용 출력은 참고 폴더를 마지막 이름(라벨)으로만 표시합니다. 단, `suggest-rules`의 초안 JSON과 `preview --json`의 `suggestedProfile`·`preview.root`는 계약(v1 `ProfileSchema`, `PreviewSchema`)상 실제 절대 경로를 담습니다. `rules save`로 저장한 프로필에는 절대 경로가 남지 않습니다.

`npm run preview -- <폴더>`, `npm run rules:suggest -- <폴더>`, `npm run rules:confirm -- <JSON> --select <ID>`, `npm run afo -- rules list`도 같은 명령입니다.
JSON을 파일로 받을 때는 npm 배너가 섞이지 않도록 `node dist/apps/cli/src/index.js ...`를 직접 실행합니다.

## 종료 코드

| 코드 | 의미 | 예 |
| --- | --- | --- |
| 0 | 성공. 결과를 stdout에 출력 | `--help`, 정상 `preview`. **스캔이 일부 미완료여도 0**이며 출력의 "스캔 일부 미완료"와 JSON `scanComplete: false`로 구분합니다 |
| 1 | 입력 거부 또는 오류 | 없는 폴더, 홈·디스크 루트 같은 거부 대상, 손상된 규칙 JSON, 모르는 규칙/수정 ID, 손상 프로필 편집, `PROFILE_CHANGED`, 프로필 잠금 대기 초과 `LOCKED_BY_OTHER` |
| 2 | 사용법 오류. 아무것도 바꾸지 않음 | 모르는 명령·옵션(`--execute` 등), 명령에 맞지 않는 옵션, 인수 개수, `--select` 없음·빈 선택, `--move` 형식, 비TTY `rules reset`에 `--confirm` 없음 |
| 4 | 확인(승인) 거부·무효 | TTY `rules reset` 질문에 y가 아닌 답, `--confirm` 값 불일치. 후속 승인 오류(`APPROVAL_*`·`PLAN_CHANGED`·`MODE_MISMATCH`)도 4 |
| 130 | Ctrl+C(SIGINT)로 취소 | 큰 폴더 스캔 중 중단, 확인 질문 중 중단 |

코드 3(일부 실패/unknown)은 실행 명령(#10 이후)에서 씁니다. 지금은 반환하지 않습니다.
오류는 stderr에 `AFO 오류[코드]: 메시지`(공용 `AfoError`) 또는 `AFO 오류: 메시지`(그 밖) 한 줄로 출력합니다.

검증: `tests/cli.test.ts`(0·1·2와 오류 형식)와 `tests/cli-rules.test.ts`(제안→저장→자동 적용→재시작→켜기/끄기→이번만/저장 수정→forget→reset·손상 프로필, 0·1·2·4)가 실제 자식 프로세스와 temp `AFO_STATE_DIR`로 확인합니다.
TTY 질문은 자식 프로세스에 pty가 없어 `run()`에 응답 함수를 넣는 프로세스 내 테스트로만 확인합니다. 130과 `PROFILE_CHANGED` 경쟁은 CLI 자동 테스트가 없습니다(미검증). 저장 API의 거부는 `tests/profiles.test.ts`, 두 프로세스 동시 저장·reset 경쟁은 `tests/verify-18-recheck.test.ts`(R18-20~22, 저장 API 직접 호출)에서 확인합니다.
