# AFO 개발 환경과 검사

이 문서에는 실제로 실행한 명령과 결과만 적습니다. 실행하지 않은 검사는 "미실행"으로 표시합니다.

## 요구 환경

- Node.js 24 (`package.json`의 `engines`: `>=24 <25`), npm. lockfile은 `package-lock.json` 하나입니다.
- 의존성: `zod` 4.6.7, 개발용 `typescript` 5.9.3, `@types/node` 24.19.2. 테스트는 Node 내장 `node --test`를 씁니다.

## 새 checkout에서 설치·검사

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm test
```

실제 실행 기록 (2026-10-26, macOS 27.0.1 arm64 실물 Mac, Node v24.18.0, npm 11.16.0, 기준 커밋 `1a82982` 위 #4 변경 작업 트리):
`node_modules`와 `dist`를 지운 뒤 위 세 명령을 순서대로 실행했습니다.

| 명령 | 종료 코드 | 결과 |
| --- | --- | --- |
| `npm ci --ignore-scripts --no-audit --no-fund` | 0 | 4개 패키지 설치 |
| `npm run typecheck` | 0 | 오류 없음 |
| `npm test` | 0 | tests 46, pass 46, fail 0, skipped 0 |

Windows: 이 Mac에서 실행하지 않았습니다. `.github/workflows/engine.yml`의 Windows·macOS CI는 이 변경에서 아직 실행되지 않았습니다(미실행). CI 결과는 VM 검증이며 실물 검증이 아닙니다.

## npm 스크립트

| 스크립트 | 실제 명령 | 의미 | 이 기록에서 |
| --- | --- | --- | --- |
| `build` | `tsc -p tsconfig.json` | `dist/`에 JS 출력 | `npm test` 안에서 실행됨 |
| `typecheck` | `tsc --noEmit` | 출력 없이 타입 검사 | 실행, 종료 0 |
| `test` | `npm run build && node --test dist/tests/*.test.js` | 빌드 뒤 `tests/*.test.ts`의 컴파일 결과 실행 | 실행, 종료 0 |
| `afo`, `preview`, `rules:suggest`, `rules:confirm` | `node dist/apps/cli/src/index.js ...` | 읽기 전용 CLI. 먼저 `npm run build` 필요 | 이 기록에서 직접 실행하지 않음 |

`node --test`는 실패한 테스트가 있으면 0이 아닌 코드로 끝납니다. 테스트 파일은 `tests/` 바로 아래의 `*.test.ts`만 실행됩니다. `tests/fixtures/` 안의 파일은 도구이며 테스트 진입점이 아닙니다.

## 상태 폴더 격리: `AFO_STATE_DIR`

`packages/filesystem/src/state.ts`의 `resolveStateDir()`가 앱 로컬 상태 폴더를 정합니다.

- `AFO_STATE_DIR`가 있으면 그 경로를 씁니다. 빈 값·공백·상대 경로(Windows에서는 드라이브 문자나 UNC가 없는 경로 포함)는 `STATE_DIR_INVALID`로 거부합니다.
- 없으면 macOS `~/Library/Application Support/AFO`, Windows `%LOCALAPPDATA%\AFO`, 그 밖에는 `$XDG_STATE_HOME/afo` 또는 `~/.local/state/afo`입니다.
- `assertStateDirOutside(stateDir, root)`는 실제 경로 기준으로 상태 폴더가 작업 폴더 안이거나, 같거나, 작업 폴더를 포함하면 `STATE_DIR_CONFLICT`로 거부합니다.

현재 CLI 명령은 상태 폴더를 읽거나 쓰지 않습니다. 상태 저장은 후속 이슈(#8 이후 서비스)에서 연결합니다.
테스트·수동 시험에서는 실제 사용자 앱 데이터 대신 temp 폴더를 지정합니다.

```sh
mkdir -p /tmp/afo-state-test   # 예시 경로. 시험마다 새 temp 폴더를 권장
AFO_STATE_DIR=/tmp/afo-state-test npm test
```

실제 확인: 세션 temp 폴더를 `AFO_STATE_DIR`로 지정해 `npm test`를 실행했고 46개 모두 통과했습니다. 실행 뒤 그 폴더는 비어 있었고 기본 경로 `~/Library/Application Support/AFO`는 생기지 않았습니다.
`AFO_STATE_DIR=rel`로 `resolveStateDir()`를 호출하면 `STATE_DIR_INVALID`가 발생했습니다.
현재 `tests/state.test.ts`는 환경 변수 대신 `resolveStateDir(env, platform, home)`에 값을 직접 넘기고, 파일 쓰기는 `mkdtemp` 폴더 안에서만 합니다.

## 합성 fixture와 baseline manifest

`tests/fixtures/index.ts` (기존 `tests/helpers.ts`에서도 re-export):

- `createFixture(spec, t?)`: 항상 새 `mkdtemp(os.tmpdir()/afo-test-*)` 폴더에 만듭니다. 기존 폴더를 대상으로 지정하는 옵션은 없습니다. 키는 `/`로 나눈 상대 경로이고, `/`로 끝나면 빈 폴더입니다. `..`·절대 경로·역슬래시는 거부합니다. `t`를 넘기면 테스트 종료 때 폴더를 지웁니다.
- `sampleSpec()`: 한글(NFC·NFD), 공백, 이모지, 빈 파일, 깊은 중첩, 같은 내용의 두 파일, 빈 폴더를 담은 표본.
- `createManifest(root)`: 숨김 파일을 포함하고 링크를 따라가지 않는 독립 baseline(종류·크기·수정 시각·SHA-256). 결과는 prototype 없는 객체라 `__proto__`·`constructor` 같은 이름도 일반 항목입니다.
- `diffManifest(before, after, { ignoreModified? })`: `added`/`removed`/`changed` 정렬 목록. 기본은 수정 시각 변경도 `changed`로 셉니다. JSON에서 다시 읽은 baseline도 `Object.hasOwn`으로 비교합니다.

## 공용 계약

`packages/contracts/src/index.ts`에 기존 읽기 전용 계약과 함께 쓰기 경로 계약이 있습니다:
`ErrorCodeSchema`/`AfoError`, `RootGrantSchema`, `ReferenceGrantSchema`, `PlanOperationSchema`, `OperationPlanSchema`, `ApprovalSchema`, `JournalEntrySchema`, `ExecutionReportSchema`.
스키마 검사는 형태와 내부 일관성만 확인합니다. 승인의 권위·plan hash 재계산·파일 재검증은 후속 공용 실행 서비스의 책임이며 아직 구현되지 않았습니다.
