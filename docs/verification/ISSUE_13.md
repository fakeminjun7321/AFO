# #13 중단 복구·동시 실행 검증 기록

2026-10-26 PR 검토 후 변경: 잠금 키는 선택마다 바뀌는 `RootGrant.id` 대신 실제 폴더의 `device`·`inode`로 계산합니다. 아래 기존 검증 수치는 변경 전 기록입니다. 최신 수정·검증은 [PR 검토 결함 수정](PR_REVIEW_FIXES.md)을 참고합니다.

#13은 세 부분(루트 잠금 → 중단 복구 `inspectRuns` → 결함 주입 검증)으로 나눠 진행합니다. 이 문서는 현재 **1부: 루트 잠금**만 다룹니다.
실제 이동·휴지통·삭제 실행(`executeBatch`, #10–#12)과 복구 보고는 아직 이 잠금과 연결되지 않았고, 여기서 검증하지 않았습니다.

## 루트 잠금

구현: `packages/filesystem/src/lock.ts`. 테스트: `tests/lock.test.ts`. `packages/filesystem/src/index.ts`에서는 내보내지 않습니다.

```ts
withRootLock<T>(stateDir: string, identity: { device: string; inode: string }, fn: () => Promise<T>): Promise<T>
readRootLock(stateDir, rootGrantId): Promise<{ state: 'free'|'held'|'stale'|'foreign-host'|'corrupt'; holder: RootLockHolder | null }>
```

### 파일 형식

- 경로: `<상태 폴더>/locks/<SHA-256([device,inode])>.lock`. RootGrant 자체 또는 그 폴더 식별을 전달합니다. `RootGrant.id` 문자열은 거부합니다. grant의 발급·승인·재검증은 실행 서비스 책임이며 잠금 자체가 파일 권한을 부여하지 않습니다.
- `locks/` 폴더는 `mkdir(recursive, 0o700)`로 만들고, 링크·일반 파일이면 `STATE_CORRUPT`로 거부합니다.
- 생성: `open(O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW, 0o600)`(= `wx`, Windows에는 `O_NOFOLLOW`가 없어 생략) → 한 줄 JSON 기록 → fsync → close.
- 내용(`RootLockSchema`, lock.ts 안의 `z.strictObject`): `{"formatVersion":1,"pid":<양의 정수>,"hostname":"<os.hostname()>","startedAt":"<ISO>","token":"<32자리 16진수>"}`. 읽기 한도 4096바이트, UTF-8 엄격 해석.
- 재진입 없음: 같은 프로세스 안의 두 번째 호출(예: 한 주 프로세스의 두 GUI 창)도 `LOCKED_BY_OTHER`이며 그 `fn`은 실행되지 않습니다.

### 잠금이 이미 있을 때의 판정(EEXIST)

| 기존 잠금 | 판정 | 동작 |
| --- | --- | --- |
| 일반 파일이 아님(심볼릭 링크, 폴더 등) | corrupt | `LOCKED_BY_OTHER`. 따라가거나 지우지 않음 |
| 비어 있음·JSON 아님·계약 위반·4096바이트 초과·UTF-8 아님 | corrupt | `LOCKED_BY_OTHER`. 지우지 않음(다른 프로세스가 기록 중이거나, 생성과 기록 사이에 중단됐을 수 있음). 메시지에 잠금 파일 경로와 직접 해제 조건 |
| `hostname`이 이 컴퓨터와 다름 | foreign-host | `LOCKED_BY_OTHER`. 원격 pid는 확인할 수 없어 pid가 없어 보여도 지우지 않음 |
| 같은 컴퓨터, `process.kill(pid, 0)` 성공 또는 `EPERM` | held | `LOCKED_BY_OTHER`. 메시지에 pid·시작 시각 |
| 같은 컴퓨터, `process.kill(pid, 0)`이 `ESRCH` | stale | 아래 절차로 치우고 배타 생성을 다시 시도(전체 시도 최대 3회) |
| 그 밖의 `kill` 오류 | held로 취급 | 막는 방향(지우지 않음) |

stale 해제 절차: 기존 파일을 고유한 이웃 이름 `<lock>.stale-<16진수>`로 `rename` → 옮긴 파일을 다시 읽어 stale로 판단한 바이트와 비교
→ 같으면 `unlink` 후 재시도, 다르면(그 사이 다른 프로세스가 새 잠금을 만든 경우) `link(옮긴 파일, 잠금 경로)`로 덮어쓰지 않고 되돌린 뒤
옮긴 이름을 지우고 `LOCKED_BY_OTHER`. `link`가 `EEXIST`면 세 번째 프로세스가 이미 잠금을 가진 것이므로 되돌리지 않습니다.
`link`가 그 밖의 오류(지원 안 함 등)면 옮긴 파일을 남기고 두 경로를 메시지에 적어 `LOCKED_BY_OTHER`.

### 해제

- `fn`이 성공하든 실패하든 `finally` 단계에서 잠금 파일을 다시 읽어 **token이 우리 것일 때만** `unlink`합니다. 다른 내용으로 바뀌었으면 지우지 않습니다.
- `fn`이 실패하면 그 오류를 그대로(같은 객체) 다시 던집니다. 이때 해제도 실패하면 `fn` 오류를 가리지 않도록 `process.emitWarning`(code `AFO_LOCK_RELEASE_FAILED`, stderr)으로만 알립니다.
- `fn`이 성공했는데 해제가 실패하면 `fn` 결과 대신 `AfoError`를 던집니다(메시지 `작업은 끝났지만 …`). 잠금이 사라졌거나 바뀌었으면 `STATE_CORRUPT`(실행 중 배타성이 깨졌을 수 있으니 저널 확인), `unlink` 실패는 `PERMISSION_DENIED`/`UNKNOWN`.
  호출자(예: `executeBatch`)의 실행 결과는 저널에 남아 있으므로 그 오류를 "작업이 실행되지 않았다"로 해석하면 안 됩니다.
- 보장: `LOCKED_BY_OTHER`와 `ROOT_FORBIDDEN`은 `fn` 실행 전에만 나옵니다. 해제 오류는 `fn`이 성공한 뒤에만 던져집니다.

### 자동으로 풀지 않는 잠금과 직접 해제 방법

corrupt·foreign-host 잠금, 그리고 pid가 살아 있는 held 잠금은 자동 해제하지 않습니다. 사용자는 해당 작업 폴더를 쓰는 AFO 실행이
(그 컴퓨터를 포함해) 하나도 없음을 확인한 뒤 오류 메시지에 적힌 `locks/<폴더 식별 해시>.lock` 파일을 직접 지웁니다. `readRootLock`은 상태만 보고하며 아무것도 지우지 않습니다.

### 알려진 한계(수정하지 않음)

- **pid 재사용**: 충돌·재시작 뒤 같은 번호를 다른 프로세스가 쓰면 죽은 잠금이 살아 있는 것으로 보입니다. 막는 방향이며 직접 해제가 필요합니다.
- **SIGKILL·전원 차단**: 잠금 파일이 남고, 다음 획득자가 pid가 없음을 확인할 때 stale로 치웁니다. 생성과 기록 사이에 죽으면 빈 파일이 남아 직접 해제가 필요합니다.
- **hostname 변경**: 이 컴퓨터의 이름이 바뀌면 자기 잠금도 foreign-host로 보여 막힙니다(직접 해제).
- **잔여 경쟁**: stale 해제 중 B가 새 잠금 Y를 만든 직후 A가 Y를 옆으로 옮기고, A가 되돌리기 전 그 빈틈에 C가 새 잠금을 만들면 `link`가 `EEXIST`가 되어 B와 C가 동시에 잠금을 가졌다고 믿을 수 있습니다.
  세 프로세스가 같은 stale 잠금을 마이크로초 단위로 동시에 다툴 때만 생기며, 그 경우 B의 해제는 token 불일치로 `STATE_CORRUPT`를 냅니다. 원자적 비교 교체가 없는 파일 잠금의 한계로 남깁니다.
  또 A가 Y를 옆으로 옮긴 순간 B가 정상 해제하면 B는 "잠금이 사라짐" 오류를 받습니다(작업은 끝난 뒤).
- 결정적으로 재현할 주입 지점이 없어 위 되돌리기(`link`) 경로는 테스트에 포함하지 않았습니다. 두 프로세스의 동시 stale 인수 경쟁만 실제로 실행합니다.
- 잠금은 협조적입니다. AFO가 아닌 프로그램이나 잠금을 거치지 않는 코드의 파일 변경은 막지 못합니다(실행 직전 재검증이 별도로 필요).

### 검증

```text
Issue / PR / Commit: #13(1부 루트 잠금) / PR 없음 / 기준 origin/main 6231c6a, 브랜치 feat/13-root-lock
Environment: macOS 27.0.1 (26A434) arm64, 실물 Mac(이 Mac), Node v24.18.0, npm 11.16.0
Fixture: 각 테스트가 createFixture(mkdtemp(os.tmpdir()/afo-test-*))로 만든 state/·bin/ 폴더만 사용, t.after로 삭제
Steps or exact commands:
  npm ci --ignore-scripts --no-audit --no-fund
  npm run typecheck                                   (exit 0)
  npm test                                            (tests 100, pass 98, fail 0, skipped 2, todo 0; exit 0)
  node --test dist/tests/lock.test.js  ×25 순차        (매회 tests 11, pass 11, fail 0)
  node --test dist/tests/lock.test.js  ×6 동시 실행     (매회 pass 11, fail 0)
Verification level: Unit-verified + macOS 실물에서 실제 자식 프로세스(process.execPath) 동시 실행·SIGKILL 검사. Windows: 미검증(CI 대기)
```

skipped 2개는 기존의 실제 OS 휴지통 검사(`AFO_REAL_TRASH_TEST=1`에서만 실행)이며 이 작업과 무관합니다.

| 검사(`tests/lock.test.ts`) | 근거 |
| --- | --- |
| 실제 자식 A 보유 중 자식 B는 종료 코드 3·`ERROR LOCKED_BY_OTHER`, A 해제 뒤 자식 C 획득·해제, 잠금 파일 없음 | 자식 종료 코드·stdout |
| 다른 rootGrantId는 서로 막지 않음(자식·부모 모두) | 종료 코드 0 |
| 같은 프로세스 중첩 호출과 동시 두 호출: 하나만 실행, 나머지 `LOCKED_BY_OTHER`, `fn` 미실행 | 실행 횟수 1 |
| SIGKILL된 자식의 잠금(죽은 pid) 남음 → `readRootLock` stale → 부모가 인수·`fn` 실행·파일 삭제, `.stale-*` 잔여 없음 | 파일 내용·존재 |
| 두 자식이 같은 stale 잠금을 동시에 인수: 정확히 하나만 획득, 다른 하나는 종료 코드 3 | 종료 코드·holder pid |
| 살아 있는 자식 pid로 직접 쓴 잠금: `LOCKED_BY_OTHER`(pid·시작 시각 포함), 바이트 동일, 자식 종료 뒤 stale로 보고만 함 | 바이트 비교 |
| 다른 hostname(죽은 pid)·빈 파일·잘린 JSON·필드 누락·추가 필드·다른 버전·4096바이트 초과·잘못된 UTF-8: 모두 `LOCKED_BY_OTHER`, 경로 포함, 바이트 동일 | 바이트 비교 |
| 잠금 경로의 심볼릭 링크(대상은 stale처럼 보이는 내용)·폴더: `LOCKED_BY_OTHER`, 링크·대상·폴더 그대로 | lstat·대상 바이트 |
| `fn` 오류 객체·문자열 거부값을 그대로 전달, 성공 값 반환, 양쪽 모두 잠금 삭제 | 동일성 비교 |
| `fn` 실행 중 token이 바뀌면 지우지 않음(`STATE_CORRUPT`), 잠금이 사라져도 `STATE_CORRUPT`, `fn` 실패 시에는 `fn` 오류 + 경고 `AFO_LOCK_RELEASE_FAILED` | 파일 바이트·경고 code |
| 잘못된 rootGrantId 8종: `ROOT_FORBIDDEN`, 상태 폴더에 아무것도 생기지 않음 | readdir |

Windows의 `process.kill(pid, 0)`·`O_EXCL`·`link`·심볼릭 링크 권한 동작은 이 Mac에서 확인할 수 없습니다. 심볼릭 링크 검사는 Windows에서 `EPERM`이면 명시적 skip 메시지로 건너뜁니다.
