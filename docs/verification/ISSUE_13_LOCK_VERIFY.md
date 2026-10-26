# #13 루트 잠금 독립 검증 기록 (verifier)

대상: PR #30, 브랜치 `origin/feat/13-root-lock`, 커밋 `222989877d2a1da7bd909f4e52abdaa31ddbde1c`의 `packages/filesystem/src/lock.ts`.
검증 브랜치: `verify-13-lock`(제품 코드 수정 없음). 추가 파일: `tests/verify-13-lock.test.ts`, 이 문서.
builder의 `tests/lock.test.ts`·`docs/verification/ISSUE_13.md`는 근거로 쓰지 않았고 재실행만 했습니다.

## 결론

이슈 #13 완료 조건 1 "같은 루트의 다중 창/프로세스 실행을 막고 stale lock의 해제 기준을 검증한다"는 이 커밋에서 **FAIL**입니다.

- 빈(free) 잠금 경쟁, 살아 있는 보유자 차단, SIGKILL 뒤 stale 인수, 링크·pid 경계, 해제 소유권은 통과했습니다.
- **stale 잠금을 3개 이상 프로세스가 동시에 인수하면 2–4개가 동시에 fn을 실행합니다**(C2: 8개 경쟁 시 20회 중 15–19회, 3개 경쟁 시 40회 중 13회).
  builder 문서는 이를 "마이크로초 단위 동시 경쟁에서만" 생기는 한계로 적었지만, 실제로는 3개 경쟁에서도 약 1/3의 확률로 재현됩니다. 2개 경쟁에서는 40회 중 0회.
- 해제(release)의 검사→삭제 사이에 다른 프로세스의 잠금을 지울 수 있습니다(R2, 결정적 재현).
- 잠금 키가 발급마다 다른 RootGrant.id이면 같은 폴더의 두 실행이 서로 막지 않습니다(R4). 아래 "grant-id 키에 대한 판단" 참고.

## 환경

```text
Issue / PR / Commit: #13 완료 조건 1 / PR #30 / 2229898 (검증 테스트는 verify-13-lock 브랜치)
Environment: macOS 27.0.1 (26A434), arm64, 실물 Mac(이 Mac), Node v24.18.0, npm 11.16.0 — physical
Fixture: 각 테스트가 createFixture(mkdtemp(os.tmpdir()/afo-test-*))로 만든 state/·outside/·work/·log/·bin/만 사용, 끝나면 삭제
```

## 실행한 명령과 실제 결과

```text
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck                                        exit 0
npm test (2229898 그대로)                                  tests 100, pass 98, fail 0, skipped 2, todo 0
npm test (검증 테스트 추가 후)                             tests 113, pass 106, fail 0, skipped 2, todo 5
node --test dist/tests/verify-13-lock.test.js  ×6 순차     매회 tests 13, pass 8, fail 0, todo 5
  C2(8 프로세스 × 20회)의 2명 이상 동시 보유 회수: 18, 16, 19, 15, 19, 16
AFO_VERIFY_LOCK_N=3 AFO_VERIFY_LOCK_TRIALS_STALE=40 node --test --test-name-pattern=V13-C2 dist/tests/verify-13-lock.test.js
  → 40회 중 13회 2명 이상 동시 보유
AFO_VERIFY_LOCK_N=2 AFO_VERIFY_LOCK_TRIALS_STALE=40 (같은 명령) → 40회 중 0회
```

skipped 2는 기존 실제 휴지통 검사(`AFO_REAL_TRASH_TEST=1`에서만 실행)입니다. todo 5는 아래 FAIL/위험을 재현하는 검사로,
`node:test`의 `todo`라 실패해도 `npm test`를 실패시키지 않습니다. 출력에 `# FAIL at 2229898` 표시와 assertion 내용이 나옵니다.
수정 커밋이 오면 `todo`를 빼고 일반 검사로 바꿔야 합니다.

## 항목별 결과

| ID | 검사 | 결과 | 근거 |
| --- | --- | --- | --- |
| C1 | 빈 잠금에 실제 자식 8개 동시 경쟁(8회): 보유자 정확히 1, 나머지 7개 종료 코드 3 `LOCKED_BY_OTHER`, 진 쪽 fn 미실행, S/E 로그 겹침 없음, 끝난 뒤 잠금·`.stale-*` 없음 | PASS | 자식 stdout·종료 코드, 공유 로그 |
| C2 | 죽은 pid의 stale 잠금을 자식 8개가 동시 인수(20회): 동시 보유자 없음 | **FAIL** | 20회 중 15–19회 2–4명이 동시에 fn 실행. 추가 보유자는 해제 때 `STATE_CORRUPT`(이미 fn 실행 뒤). 진 쪽 fn 미실행·`.stale-*` 잔여 없음·최종 잠금 없음은 성립 |
| C3 | 보유자 실행 중·SIGSTOP 중이면 다른 프로세스 차단(바이트 그대로) → SIGKILL 뒤 stale → 다음 프로세스 인수·해제 | PASS | 종료 코드, 잠금 바이트, 로그에 E 없음 |
| C4 | async 안의 동기 throw, 비 async 동기 throw, undefined·null·0·''·문자열·`{code:'LOCKED_BY_OTHER'}`·Symbol 거부값, 비 Promise 반환 | PASS | 같은 값 그대로 전달, 매번 잠금 삭제 |
| C5 | fn이 끝나지 않은 채 프로세스 정상 종료(코드 13), fn 안의 `process.exit(0)` | PASS | 잠금이 남고 `stale`로 판정, 다음 프로세스 인수 |
| C6 | `locks/`가 바깥 폴더 링크 → `STATE_CORRUPT`; 잠금 파일이 끊긴 링크·바깥 폴더 링크·바깥 stale 잠금 링크 → `LOCKED_BY_OTHER`; 바깥 stale 잠금의 하드 링크 → 인수하되 바깥 바이트 유지 | PASS | 바깥 폴더 manifest 전후 동일, 링크 그대로, 끊긴 대상 미생성, 새 잠금은 다른 inode |
| C7 | pid 경계: 자기 pid+다른 token, pid 1(EPERM), 2^32+1·MAX_SAFE_INTEGER(kill이 ERR_INVALID_ARG_TYPE), 다른 hostname → held/foreign-host로 차단; 0·-1·-12345·1.5·"123"·1e400·null·2^53+1·빈 파일 → corrupt로 차단; 모두 바이트 그대로. 죽은 자식 pid와 2^31-1(ESRCH)만 stale로 인수 | PASS | 바이트 비교, `readRootLock` 상태 |
| C8 | fn 중 잠금이 옮겨지고 실제 자식이 획득 → 해제는 `STATE_CORRUPT`(`작업은 끝났지만…`), 자식 잠금·옮긴 파일 그대로, 자식은 정상 해제; fn 실패+잠금 교체 → fn 오류 그대로 + 경고 `AFO_LOCK_RELEASE_FAILED`; fn 성공+잠금 사라짐 → fn 실행 뒤 `STATE_CORRUPT` | PASS | 바이트 비교, 경고 code |
| C9 | `locks`가 일반 파일 → `STATE_CORRUPT`(파일 그대로); `locks` 쓰기 불가(0o500) → `PERMISSION_DENIED`; 잘못된 키 6종 → `ROOT_FORBIDDEN`, 상태 폴더 미생성; fn 미실행 | PASS | 오류 code, 존재 확인 |
| R1 | stale 인수 중 되돌리기 빈틈의 두 번째 보유자(결정적 재현) | **FAIL** | 아래 R1 |
| R2 | 해제의 검사→삭제 빈틈에서 다른 프로세스 잠금 삭제(결정적 재현) | **FAIL** | 아래 R2 |
| R3 | 상대 경로 stateDir | 위험(계약 미명시) | 아래 R3 |
| R4 | 같은 폴더에 대한 서로 다른 grant 발급 두 개 | **FAIL(설계)** | 아래 R4 |
| — | Windows의 `kill(pid,0)`·`O_EXCL`·`link`·심볼릭 링크 동작 | NOT-RUN | Windows: 미검증(CI 대기). C3·C6·C9는 Windows에서 skip 처리 |

## 실패 재현

R1·R2는 이 테스트 프로세스 안에서 `node:fs/promises`의 `rename`/`unlink`에 대기 지점(gate)을 걸어(`syncBuiltinESMExports`)
**실제 lock.ts 코드 경로의 실행 순서만** 고정합니다. 다른 행위자는 실제 자식 프로세스입니다. sleep은 쓰지 않습니다.

### C2 — 자연 경쟁에서 동시 보유

- 재현: `npm run build && node --test --test-name-pattern=V13-C2 dist/tests/verify-13-lock.test.js`
- 기대: 회차마다 보유자 1명. 실제: 대부분의 회차에서 2–4명이 동시에 `ACQUIRED` 상태로 fn 실행, 1명만 `RELEASED ok`, 나머지는 해제 때 `ERROR STATE_CORRUPT`.
- 원인(R1과 같은 경로): stale로 판정한 프로세스 B가 `rename(lock, aside)`를 할 때 이미 다른 프로세스 A의 새 잠금이 그 자리에 있으면 A의 잠금을 옮깁니다.
  B가 `link`로 되돌리기 전까지 잠금 경로가 비어 있어 C가 배타 생성에 성공하고, B의 `link`는 `EEXIST` → B는 A의 잠금(옮긴 파일)을 지우고 포기합니다.

### R1 — 되돌리기 빈틈 (`V13-R1`)

1. 죽은 pid의 잠금 S 작성. 이 프로세스의 호출 B가 S를 stale로 판정하고 `rename` 직전에 멈춤.
2. 자식 A가 같은 S를 인수해 보유(`ACQUIRED`).
3. B의 `rename` 진행 → A의 잠금이 `.stale-*`로 옮겨지고 잠금 경로가 빔. B는 그 직후 멈춤.
4. 자식 C 시작 → `ACQUIRED`.
5. B 진행 → `link` EEXIST → 옮긴 A 잠금 삭제, B는 `LOCKED_BY_OTHER`.

기대: C는 `LOCKED_BY_OTHER`. 실제: `B: LOCKED_BY_OTHER; C: acquired; A exit 1 ERROR STATE_CORRUPT; C exit 0; max concurrent fns 2`.

### R2 — 해제가 남의 잠금을 지움 (`V13-R2`)

1. S 작성. 호출 B가 stale 판정 후 `rename` 직전에 멈춤.
2. 호출 A가 S를 인수, fn 종료, `release`가 잠금을 읽어 token 일치 확인 후 `unlink` 직전에 멈춤.
3. B의 `rename`이 A의 잠금을 옮김 → 자식 C가 빈 경로에 잠금 생성·보유.
4. B 진행 → `link` EEXIST → 포기. A의 `unlink` 진행 → **C의 잠금 파일 삭제**, A는 정상 반환.
5. 자식 D 시작.

기대: C의 잠금 유지, D는 종료 코드 3. 실제: `A: A done; C lock survived: false; D exit 0 (ACQUIRED…/RELEASED ok); C exit 1 ERROR STATE_CORRUPT`.
원인: `release()`가 `inspect`(token 확인)와 `unlink(file)`을 경로 기준으로 따로 수행합니다. 확인한 파일과 지우는 파일이 같다는 보장이 없습니다.

### R3 — 상대 경로 stateDir (`V13-R3`, 위험)

`withRootLock`은 stateDir가 절대 경로인지 확인하지 않습니다. cwd가 다른 두 자식이 `rel-state`로 같은 키를 쓰면 둘 다 획득합니다(`B exit 0`).
`resolveStateDir`는 절대 경로를 강제하므로 현재 CLI 경로에서는 생기지 않지만, 공용 함수 계약에는 없습니다. 절대 경로 거부를 권장합니다.

### R4 — 발급마다 다른 grant ID로 키를 만들 때 (`V13-R4`)

테스트 어댑터 `keyFor(folder, issuance)`가 발급마다 다른 ID(발급 이름+실제 경로의 sha256)를 만들어, 같은 `work/` 폴더에 대해
자식 A(발급 1)가 보유 중일 때 자식 B(발급 2)도 획득합니다(`B exit 0`). 어댑터를 새 키 형식으로 바꾸면 같은 검사로 수정 여부를 확인합니다.

## grant-id 키에 대한 판단 (coordinator 요청)

독립적으로 보아도 **결함입니다.** `RootGrantSchema`에는 `sessionId`·`issuedAt`이 있어 grant는 발급(세션)마다 다른 객체이고,
ID가 발급마다 달라지면 두 CLI 프로세스나 두 GUI 창이 같은 폴더에 각자 grant를 발급할 때 서로 다른 잠금 파일을 쓰게 됩니다. 완료 조건 1의 "같은 루트"는 폴더 기준이어야 합니다.
`{ canonicalPath, device, inode }`의 device+inode 키로 바꾸는 방향에 동의하며, 다음을 함께 검증해야 합니다.

- **겹치는 루트**: 부모 폴더와 그 하위 폴더를 각각 루트로 잡으면 키가 달라 서로 막지 않습니다. 하위 폴더의 파일을 두 실행이 함께 다룰 수 있으므로 겹침 거부나 조상 잠금 확인이 필요합니다.
- Windows의 NTFS 파일 ID는 2^53을 넘을 수 있으니 `stat(..., { bigint: true })`로 읽어야 합니다. device는 볼륨 일련번호입니다(미검증).
- 폴더를 지우고 다시 만들면 inode가 바뀌어 남은 잠금과 키가 달라집니다(막는 방향은 아님, 잔여 파일만 생김). 외장 볼륨 재연결 시 device 번호 변경도 같습니다.
- 키 계산 직후 폴더가 바뀌는 경쟁(경로 교체)은 실행 직전 재검증이 따로 막아야 합니다.

## 미검증

- Windows 전체: 미검증(CI 대기).
- R1·R2의 대기 지점 주입은 실제 코드 경로이지만 순서를 강제한 것입니다. 자연 발생 빈도의 근거는 C2 측정값뿐입니다.
- 전원 차단·디스크 가득 참(`ENOSPC`)·잠금 기록 도중 종료로 남는 빈 잠금은 C7의 빈 파일 차단만 확인했습니다. 실제 장애 주입은 하지 않았습니다.
- `executeBatch`·복구와 잠금의 연결은 아직 구현되지 않아 검증하지 않았습니다.
