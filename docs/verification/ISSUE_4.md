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
