# #4 공용 계약·상태 폴더·fixture 도구 독립 검증

역할: verifier. 날짜: 2026-10-26. 이 기록은 #4 중 이번 범위(쓰기 경로 공용 계약, 상태 폴더 유틸, 합성 fixture·manifest 도구, CI 정의, DEVELOPMENT.md)만 다룹니다.
RootGrant 발급 서비스, plan hash 재계산, 승인 소비·실제 이동/삭제는 #6/#8 이후 범위이며 여기서 검증하지 않았습니다.
검증자는 제품 코드(`packages/`, `apps/`)와 builder 파일을 수정하지 않았고 `tests/verify-4.test.ts`와 이 문서만 추가했습니다.

```text
Issue / PR / Commit: #4 / PR 없음(미생성) / 대상 eae4872 (기능: 쓰기 경로 공용 계약·상태 폴더·합성 fixture 도구 추가), 검증 브랜치 verify-4
Environment: macOS 27.0.1 (26A434) arm64, 실물 Mac, Node v24.18.0, npm 11.16.0. temp 볼륨은 대소문자 구분 없음(APFS 기본)
Fixture and baseline manifest: 모든 파일 작업은 realpath(os.tmpdir())/afo-test-* 아래 새 mkdtemp 폴더. AFO_STATE_DIR=<세션 scratchpad>/afo-state-v4 (빈 폴더)
Steps or exact commands:
  rm -rf node_modules dist && npm ci --ignore-scripts --no-audit --no-fund && npm run typecheck && npm test   (검증 테스트 추가 전, eae4872 그대로)
  rm -rf node_modules dist && npm ci ... && npm run typecheck && AFO_STATE_DIR=<scratchpad>/afo-state-v4 npm test   (verify-4 추가 후)
Observed files / hashes / journal / exit status: 아래 표
Passed / Failed / Not run: 아래 완료 조건 표
Verification level: Unit-verified + macOS 실물 temp 파일 검사. Windows 미검증(CI 미실행). CI(VM) 미실행
Not verified and reason: Windows 동작(이 Mac에서 불가), GitHub Actions 실제 실행(coordinator가 PR CI로 확인 예정), 서비스 계층(범위 밖)
Release blocker and unblock condition: 출시 차단 결함 없음. 아래 FAIL 1건(테스트 oracle)은 후속 검증 신뢰도 문제이므로 #6 전 수정 권장
```

## 실행 결과

| 단계 | 명령 | 종료 코드 | 결과 |
| --- | --- | --- | --- |
| 재현(eae4872) | `npm ci --ignore-scripts --no-audit --no-fund` | 0 | 4개 패키지 설치 |
| 재현(eae4872) | `npm run typecheck` | 0 | 오류 없음 |
| 재현(eae4872) | `npm test` | 0 | tests 45, pass 45, fail 0, skipped 0, todo 0 — DEVELOPMENT.md 기록과 일치 |
| 검증 추가 후 | `npm ci` → `npm run typecheck` → `AFO_STATE_DIR=… npm test` | 0 / 0 / 0 | tests 64, pass 63, fail 0, skipped 0, todo 1 (verify-4: 19개, 그중 todo 1은 아래 결함 재현) |
| 실행 후 확인 | `ls -A <AFO_STATE_DIR>` | — | 0개 항목(비어 있음) |
| 실행 후 확인 | `~/Library/Application Support/AFO` 존재 여부 | — | 실행 전·후 모두 없음(생성되지 않음) |
| 실행 후 확인 | `$TMPDIR/afo-test-*` 잔여 | — | 0개(모든 fixture 정리됨) |

## 완료 조건별 판정

| 항목 | 판정 | 근거 |
| --- | --- | --- |
| 1. 새 checkout 설치·typecheck·test 재현, DEVELOPMENT.md 수치·명령 대조 | PASS | 위 표. 4 패키지·exit 0·45/45, Node/npm/OS 버전 일치 |
| 2a. 신규 스키마 8종 유효 예시 통과 + 키 제거·자료형 변경·`approved: true` 추가 실패 | PASS | V4-C1: 중첩 객체 포함 200개 넘는 변형 모두 거부 |
| 2b. 경계값(음수 size, 잘못된 hex, 빈 operationIds, 10분+1ms 승인, keeper 키 누락 등) | PASS | V4-C2~C6. 10분 정각은 통과, +1ms 거부. 대소문자·NFD 같은 목적지/원래 경로 거부 |
| 2c. ErrorCode 설계 목록 포함, 미지 코드 거부 | PASS | V4-C7. 설계 25개 + 추가 `STATE_DIR_INVALID`, `STATE_CORRUPT` |
| 2d. 기존 Scan/Profile/Preview 계약과 기존 CLI 테스트 유지 | PASS | V4-C8, 기존 `cli/engine/scanner/contracts` 테스트 전부 통과. contracts diff는 63행 이후 추가만 있음 |
| 3a. `AFO_STATE_DIR` 해석(빈값·공백·상대·`~`) | PASS | V4-S1 |
| 3b. 상태 폴더 겹침(같음·안·포함·대소문자·NFD·symlink 별칭·prefix 착각) | PASS | V4-S2, 실제 temp 폴더와 symlink |
| 3c. `writeJsonAtomic` 실패 시 기존 파일 보존·temp 잔여 없음 | PASS | V4-S3: 스키마 오류·추가 키·1 MiB 초과·대상이 폴더·읽기 전용 폴더(PERMISSION_DENIED)·symlink 대상 미변경 |
| 3d. 1 MiB 초과·symlink·손상 JSON·폴더·FIFO·잘못된 UTF-8 거부 | PASS | V4-S4. 정확히 1 MiB는 허용, +1 byte 거부. FIFO는 막힘 없이 거부 |
| 3e. 저널 append 줄 단위 파싱·잘린 마지막 줄·seq 역행·다른 runId | PASS | V4-S5. 잘린 줄 뒤 새 항목은 보존, 잘린 줄은 추측 없이 corrupt로 보고 |
| 3f. runId로 상태 폴더 탈출(`../x` 등) 거부 | PASS | V4-S6. 거부 후 상태 폴더에 아무것도 생기지 않음 |
| 3g. 기본 상태 폴더 미생성 | PASS | 실행 전·후 모두 없음 |
| 4a. fixture가 항상 os.tmpdir() 아래, `..`·절대 경로 등 거부 | PASS | V4-F1 |
| 4b. `diffManifest`가 추가·삭제·내용 변경·mtime만 변경·폴더↔파일 교체 감지 | PASS(일반 이름) / **FAIL(특정 이름)** | V4-F2 통과. V4-F3: `__proto__`·`constructor`·`toString` 등 이름에서 누락(아래 결함 1) |
| 5. CI YAML(이름·트리거·권한·step) | PASS(읽기 검토) / 실행 NOT-RUN | 아래 CI 절 |
| 6. Windows | NOT-RUN | 이 Mac에서 불가. CI 대기 |

## 결함

### 1. [FAIL, 중간] manifest oracle이 Object.prototype 이름의 파일을 보지 못함

`tests/fixtures/index.ts`의 `createManifest`는 일반 객체에 `result[relative] = …`로 넣고, `diffManifest`는 `name in after`로 비교합니다.

- `__proto__` 파일: 대입이 prototype 설정이 되어 manifest에 아예 나타나지 않습니다. 내용이 바뀌어도 diff가 비어 있습니다.
- `toString`·`hasOwnProperty`·`valueOf` 등 새 파일: `in`이 상속 속성에 true를 반환해 `added`에서 빠집니다.
- `constructor` 파일 삭제: `removed`가 아니라 `changed`로 보고됩니다.

이 이름들은 macOS·Windows에서 정상 파일명입니다. 독립 oracle이 "아무것도 바뀌지 않았다"고 잘못 판정할 수 있으므로 #10 이후 실제 이동·삭제 검증의 신뢰도에 영향을 줍니다. 제품 데이터 손실 결함은 아닙니다.

재현(`npm run build` 후):

```js
const fx = await import('./dist/tests/fixtures/index.js');
const f = await fx.createFixture({ 'a.txt': 'a', 'constructor': 'c', '__proto__': 'p' });
const m1 = await fx.createManifest(f.root);          // keys: ['a.txt', 'constructor'] — __proto__ 없음
await (await import('node:fs/promises')).writeFile(f.root + '/toString', 'x');
await (await import('node:fs/promises')).rm(f.root + '/constructor');
fx.diffManifest(m1, await fx.createManifest(f.root)); // { added: [], removed: [], changed: ['constructor'] }
```

`tests/verify-4.test.ts`의 V4-F3가 `{ todo }`로 같은 사례를 재현합니다(수정되면 통과). 수정 제안: `Object.create(null)` 또는 `Map`, `Object.hasOwn`으로 비교. builder 과제로 넘깁니다.

## 문서 차이

- 이슈 #4 완료 조건은 "실제 scripts와 종료 코드를 README에" 적도록 합니다. README에는 설치·typecheck·test 명령은 있으나 종료 코드가 없고, 종료 코드가 있는 `docs/DEVELOPMENT.md`는 README·다른 문서 어디에서도 링크되지 않습니다(`grep DEVELOPMENT` 결과 없음). README에서 DEVELOPMENT.md로 연결하거나 이슈 문구를 고칠 것을 제안합니다.
- RuleProfile의 "적용 범위" 필드는 기존 `ProfileSchema` v1에 별도 필드로 없습니다(이번 패킷에서 v1 유지를 지시). Plan/Approval의 `profileId`+`profileRevision` 결합은 확인했습니다.

## 남은 위험(FAIL 아님, 후속 서비스가 처리해야 함)

1. `AbsolutePathSchema`는 `\\?\C:\x`, `\\.\PhysicalDrive0` 같은 장치 경로, 디스크 루트 `/`, 정규화되지 않은 `/a/../b`를 통과시킵니다. 스키마 주석대로 어댑터 몫이지만 ARCHITECTURE 불변 조건 1(UNC/장치 경로 차단)은 #6 RootGrant 발급에서 반드시 검사해야 합니다.
2. `OpaqueIdSchema`가 대소문자를 모두 허용해, 대소문자만 다른 두 runId가 대소문자 무시 볼륨(이 Mac의 temp 볼륨에서 실제 확인)에서 같은 저널 파일을 씁니다. `readJournal`이 "다른 실행 ID"로 표시하는 것은 확인했습니다(V4-S7). ID 생성기를 소문자로 고정하거나 스키마를 소문자로 제한할 것을 제안합니다.
3. `OperationPlanSchema`는 move 목적지가 같은 계획의 keep/review 파일 경로와 같아도 통과합니다. 실행 시 no-clobber(`DEST_EXISTS`)가 막아야 하며, 계획 단계에서 표시하려면 스키마 또는 `buildPlan`에서 검사해야 합니다.
4. `ApprovalSchema`는 `usedAt`이 `expiresAt` 이후여도 통과합니다. 서비스가 소비 전에 만료를 검사해야 합니다.
5. delete 작업의 `keeper: null`은 허용됩니다(중복이 아닌 선택 파일 영구 삭제용으로 의도된 것으로 판단). `keeper` 키 자체 누락은 거부됩니다. coordinator의 확인이 필요합니다.
6. `writeJsonAtomic`·`appendJournal`은 스키마 오류 입력에 `AfoError`가 아닌 ZodError를, `assertStateDirOutside`는 없는 루트에 Node `ENOENT`를 그대로 던집니다. 파일은 바뀌지 않지만, CLI 종료 코드 매핑에서 따로 처리해야 합니다.

## CI 정의 검토(읽기만, 실행 안 함)

`.github/workflows/engine.yml`: 이름 `엔진 검증` / `push` (branches: main, paths 필터) / `pull_request` (같은 paths 필터) / `workflow_dispatch` / `permissions: contents: read` / matrix `windows-latest`, `macos-latest`, `fail-fast: false`, timeout 10분 / steps: checkout → setup-node 24(npm cache) → `npm ci --ignore-scripts --no-audit --no-fund` → `npm run typecheck` → `npm test`.
고정 SHA는 `gh api`로 조회한 현재 태그와 일치했습니다: `actions/checkout` v4 = `11d5960…`, `actions/setup-node` v4 = `49933ea…`.
paths 필터에 `tests/**`가 있어 검증 테스트 변경도 CI를 실행합니다. 문서만 바뀐 PR은 이 워크플로를 실행하지 않습니다(의도와 일치). 실제 실행 결과는 미확인입니다.

## 추가한 검증 테스트

`tests/verify-4.test.ts` (19개): V4-C1~C8 계약, V4-S1~S7 상태 폴더·원자적 쓰기·읽기·저널·runId, V4-F1~F3 fixture·manifest, V4-Z 기본 상태 폴더 미생성.
builder 테스트를 재사용하지 않았고, 파일 작업은 모두 새 temp 폴더에서 수행한 뒤 지웠습니다.

## 재검증: builder 수정 61c737d·bfd5970 (integ/m1)

날짜: 2026-10-26. 브랜치 `verify-4b` = `integ/m1`(bfd5970) + 검증 테스트 갱신. 환경은 위와 같은 실물 Mac(macOS 27.0.1 arm64, Node v24.18.0, npm 11.16.0)입니다. 제품 코드는 수정하지 않았습니다.

```text
rm -rf node_modules dist && npm ci --ignore-scripts --no-audit --no-fund   -> exit 0, 4 packages
npm run typecheck                                                          -> exit 0
AFO_STATE_DIR=<scratchpad>/afo-state-v4 npm test                           -> exit 0
tests 87 / pass 85 / fail 0 / cancelled 0 / skipped 2 / todo 0
```

건너뛴 2개는 #3의 실제 OS 휴지통 검사입니다(`AFO_REAL_TRASH_TEST=1`이 아니라서 건너뜀). #4 범위가 아니며 통과로 세지 않습니다. verify-4 19개는 모두 통과했습니다.
실행 후 AFO_STATE_DIR은 비어 있었고, `~/Library/Application Support/AFO`는 생기지 않았으며, `$TMPDIR/afo-test-*`는 남지 않았습니다.
`docs/DEVELOPMENT.md`의 "tests 46"은 builder 커밋 단독의 수치입니다. integ/m1에는 #3 테스트와 검증 테스트가 더 있어 87개입니다(모순이 아니라 기준 커밋 차이입니다).

| 이전 지적 | 재검증 결과 | 근거 |
| --- | --- | --- |
| 결함 1: 특수 이름 manifest | **PASS(해결)** | V4-F3를 일반 테스트로 바꿈. `__proto__` 파일이 manifest의 own key로 나타나고, 내용 변경은 `changed`, 삭제는 `removed`, `toString`·`hasOwnProperty`·`valueOf` 추가는 `added`로 잡힘. manifest는 계속 일반 객체(prototype = Object.prototype) |
| 위험 2: 대소문자 runId 충돌 | **PASS(해결)** | V4-S7을 바꿈. 대문자나 대소문자 혼합 runId는 `journalFile`에서 거부, 항목 안의 대문자 runId·approvalId는 `appendJournal`에서 `JOURNAL_FAILED`. 상태 폴더에 아무것도 생기지 않음. RootGrant·Approval·ExecutionReport의 대문자 opaque ID도 거부 |
| 위험 6: 원시 오류 전파 | **PASS(해결)** | 스키마 오류·추가 키는 `writeJsonAtomic` → `STATE_CORRUPT`, `appendJournal` → `JOURNAL_FAILED`. 없는 루트 → `ROOT_FORBIDDEN`, 읽을 수 없는 루트(chmod 000 부모) → `PERMISSION_DENIED`, 파일 아래 상태 경로 → `STATE_DIR_INVALID`. 기존 파일 보존과 temp 잔여 없음은 유지 |
| 위험 1, 3, 4, 5 | 변경 없음(열림) | 장치 경로·`/` 허용, move 목적지 = keep 파일 허용, `usedAt` > `expiresAt` 허용, delete `keeper: null` 허용은 그대로. #6/#8 서비스에서 처리하거나 coordinator가 결정 |
| 문서 차이(README 종료 코드·DEVELOPMENT.md 링크) | 변경 없음(열림) | README·docs에서 DEVELOPMENT.md를 링크하는 곳이 아직 없음 |

검증 테스트 정정: 처음 V4-F3 재현에서는 객체 리터럴 `{ '__proto__': 'p' }`를 썼습니다. 이 구문은 prototype을 설정할 뿐 파일을 만들지 않습니다. 계산된 키 `['__proto__']`로 바꾸고 fixture가 실제로 그 파일을 만들었는지 확인하도록 했습니다.
같은 입력으로 eae4872의 원래 `tests/fixtures/index.ts`를 실행하면 `__proto__` 파일이 존재해도 manifest 키가 `['a.txt', 'constructor']`이고 diff는 `{added:[], removed:[], changed:['constructor']}`였습니다. 따라서 결함 1의 원래 판정(FAIL)은 유효합니다. 같은 입력에서 수정본은 `{added:['toString'], removed:['constructor'], changed:['__proto__']}`입니다.

## 부록: PR #23 병합본 기록 (다른 세션 작성, main c5beb93)


날짜: 2026-10-26. PR: [#23](https://github.com/fakeminjun7321/AFO/pull/23).
대상: `52aa45c`에 `main`의 `35f934b`를 병합한 `69a307d`.
이번 수정은 CI 충돌 해결과 누락된 검증 기록 보완입니다. 제품 코드·계약·테스트는 변경하지 않았습니다.

### 환경과 실행 결과

- macOS 27.0.1 (26A434), arm64, 실제 Mac 1대, Node v24.18.0, npm 11.16.0.
- 새 전용 worktree에서 `npm ci --ignore-scripts --no-audit --no-fund`: 종료 0.
- `npm test`: 엄격 TypeScript 빌드 성공, 69개 중 67개 통과·2개 건너뜀·실패 0, 종료 0. 두 skip은 실제 휴지통 검사입니다.
- CI와 같은 명령으로 다시 실행:

```sh
AFO_REAL_TRASH_TEST=1 node --test --test-reporter=spec --test-reporter-destination=stdout --test-reporter=tap --test-reporter-destination=/tmp/afo-pr23-revision-results.tap dist/tests/*.test.js
```

결과: **69개 통과, 실패 0, 건너뜀 0, 종료 0**. spec 출력과 TAP 파일의 테스트 수가 일치했습니다.
모든 파일 작업은 테스트가 새로 만든 합성 temp 폴더 안에서 수행했습니다.
휴지통에는 합성 파일 2개만 보냈으며 전체 휴지통 비우기나 Finder 조작은 하지 않았습니다.
`V3-12`는 해당 파일이 `~/.Trash/`에 크기 32바이트로 존재하는 것까지 확인했습니다.

### 확인한 범위

| 영역 | 실제 확인 |
| --- | --- |
| 계약 | grant 범위·파일 식별 필수 필드, 목적지·keeper·삭제 모드·요약 일관성, 승인 ID 정렬·유효 기간·프로필 버전, 저널·결과의 상태별 필드, 잘못된 자료형·장치 경로 거부 |
| 상태 저장 | OS별 상태 경로 결정, 실제 경로 기준 작업 루트 겹침 거부, JSON 교체·재읽기, 잘못된 값의 저장 거부와 이전 내용 보존, temp 파일 정리, 손상·과대·비 UTF-8 파일 거부 |
| 저널 | 검증한 항목 append 후 재읽기, 잘린 줄·다른 run ID·역순 seq·잘못된 계약 구분, 링크 경로 쓰기 거부 |
| fixture | 새 temp 루트만 생성, 경로 탈출 거부, 정리 후 부재, 독립 manifest로 추가·삭제·내용·크기·수정 시각·이동 해시 비교 |
| CLI | 실제 자식 프로세스로 규칙 제안→선택 확인→재로딩→미리보기, 원본 manifest 보존, 오류 입력 종료 코드 1·정상 종료 코드 0 |
| OS 어댑터 | macOS에서 실제 이동·덮어쓰기 거부·일반 파일 삭제·휴지통·링크 거부·이동 중간 상태 분류. 상세 사례는 [#3 기록](ISSUE_3.md) |

### 검증 수준과 남은 조건

- **Implemented / 구현**: 공용 계약, 상태 저장, fixture 도구, 두 OS CI 설정이 존재합니다.
- **Unit-verified / 단위 검증**: 위 커밋의 69개 검사가 통과했습니다. 스키마 검사는 승인 권위나 실행 계층의 안전성을 증명하지 않습니다.
- **Physical-device-verified / 실제 하드웨어 검증**: 이 Mac의 합성 파일에 대한 CLI 읽기 전용 경로와 어댑터·상태 저장 단위만 확인했습니다. 전체 파일 정리 사용자 경로는 아닙니다.
- **Simulator-verified / CI 검증**: 이번 push의 Windows·macOS hosted runner 결과는 PR checks에서 별도로 확인합니다. 로컬 결과로 대신하지 않습니다.
- **Not verified / 미검증**: Windows 실물, 쓰기 CLI·승인 서비스·루트 잠금·저널에 결합된 실행·프로세스 종료/재시작 복구·전원 장애 내구성은 이 기록에서 검증하지 않았습니다. 쓰기 CLI와 실행 서비스는 후속 이슈 범위입니다.
- 조부모 경로 링크를 통과하는 어댑터 한계(`V3-11`), Node 경로 검사와 변경 사이의 경쟁, Windows 휴지통 거부 조건의 실물 재현은 남아 있습니다. 전체 제품 준비 완료나 #3·#4의 모든 완료 조건 충족으로 해석하지 않습니다.

`main` 병합으로 중복 타입 검사 제거·이전 실행 취소를 유지하면서 PR의 실제 휴지통 env 설정과 TAP 실패 annotation을 보존했습니다.
