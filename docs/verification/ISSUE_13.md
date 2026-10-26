# #13 중단 복구·동시 실행 검증 기록

#13은 세 부분(루트 잠금 → 중단 복구 `inspectRuns` → 결함 주입 검증)으로 나눠 진행합니다. 이 문서는 현재 **1부: 루트 잠금**만 다룹니다.
실제 이동·휴지통·삭제 실행(`executeBatch`, #10–#12)과 복구 보고는 아직 이 잠금과 연결되지 않았고, 여기서 검증하지 않았습니다.

## 루트 잠금

구현: `packages/filesystem/src/lock.ts`. 테스트: `tests/lock.test.ts`. `packages/filesystem/src/index.ts`에서는 내보내지 않습니다.

```ts
interface RootLockTarget { canonicalPath: string; device: string; inode: string } // RootGrant가 구조적으로 만족
withRootLock<T>(stateDir: string, root: RootLockTarget, fn: () => Promise<T>): Promise<T>
readRootLock(stateDir, root): Promise<{ state: 'free'|'held'|'stale'|'foreign-host'|'corrupt'; holder: RootLockHolder | null }>
rootLockKey(root): string          // 64자리 16진수
rootLockFile(stateDir, root): string // 잠금 폴더 <stateDir>/locks/<key> (직접 해제 때 통째로 지우는 단위)
```

### 이력

1. 첫 구현(2229898)은 `locks/<RootGrant.id>.lock` 한 파일 + stale이면 옆 이름으로 옮겨 비교·되돌리기 방식이었습니다.
2. 8a00c24: `issueRootGrant`(#6)가 발급마다 무작위 값을 섞어 같은 폴더도 프로세스마다 ID가 달라 서로 막지 못하므로(세션 B 발견), 키를 폴더 식별(device·inode)로 바꿨습니다.
3. 독립 검증(verify-13-lock f76e8a7, `ISSUE_13_LOCK_VERIFY.md`)에서 완료 조건 1이 **FAIL**:
   C2 stale 잠금을 8개가 동시 인수하면 20회 중 15–19회 2–4개가 동시에 fn 실행(3개 경쟁도 40회 중 13회), R1 되돌리기 빈틈의 이중 보유,
   R2 해제의 검사→경로 삭제 빈틈에서 남의 잠금 삭제, R3 상대 경로 stateDir 허용. 옮기기·되돌리기와 "검사 후 경로로 삭제"는 본질적으로 경쟁이 있어
   아래의 **단조 증가 세대 파일** 방식으로 다시 설계했습니다(공개 API·오류 종류·ROOT_FORBIDDEN 검사는 8a00c24와 동일).

### 잠금 키: grant ID가 아니라 폴더 식별

- 키 = `sha256("afo-root-lock-v1\0" + device + "\0" + inode)`의 16진수. `canonicalPath`는 키에 쓰지 않으므로 대소문자·Unicode 정규화·링크를 거친 다른 표기도 같은 잠금입니다.
- 검사: `device`·`inode`는 10진 숫자 문자열(1–40자리), `canonicalPath`는 비어 있지 않은 절대 경로(POSIX·드라이브·UNC, NUL·`\\?\`·`\\.\` 거부, 4096자 이하). 아니면 디스크 접근 전에 `ROOT_FORBIDDEN`.
- `stateDir`는 NUL 없는 절대 경로여야 하며(Windows는 드라이브 문자 또는 UNC), 아니면 디스크 접근 전에 `STATE_DIR_INVALID`(R3: 상대 경로는 실행 위치마다 다른 폴더가 되어 잠금이 갈라짐).
- 호출자는 실제 폴더의 `realpath`와 `lstat({ bigint: true })`의 `dev`·`ino`(RootGrant의 `device`·`inode`)를 넘겨야 합니다. 값이 맞는지는 이 모듈이 다시 확인하지 않습니다(발급 서비스의 책임).

### 폴더와 파일

- `<stateDir>/locks/<key>/` — `stateDir`는 `mkdir(recursive, 0o700)`, `locks`와 `<key>`는 한 단계씩 `mkdir(0o700)`(EEXIST 허용) 후 lstat로 **실제 폴더**인지 확인합니다.
  링크·일반 파일이면 `STATE_CORRUPT`이고 그 링크를 통해 아무것도 만들지 않습니다. `readRootLock`도 각 단계를 lstat해 없으면 `free`, 링크·폴더 아님이면 `STATE_CORRUPT`
  (Windows는 일반 파일 아래 경로를 열 때 `ENOENT`를 돌려줘 `free`로 잘못 보고될 수 있었음 — Windows CI에서 발견).
- 세대 파일 `<n>.lock`(n은 앞자리 0 없는 양의 정수, `Number.MAX_SAFE_INTEGER` 이하): `open(O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW, 0o600)`로 만들고 한 줄 JSON 기록 → fsync.
  내용(`RootLockSchema`, strict): `{"formatVersion":1,"pid","hostname","startedAt","token"(32자리 16진수),"canonicalPath","generation"}`. `generation`은 파일 이름과 같아야 합니다.
  `canonicalPath`는 진단·직접 해제용이며 판정에 쓰지 않습니다. 읽기 한도 32 KiB, UTF-8 엄격 해석, 링크는 따라가지 않음.
- 해제 표시 `<n>.released`: 같은 방식의 O_EXCL 생성, 내용 `{"formatVersion":1,"generation","token"}`. **일반 파일**이어야 해제로 인정합니다(링크·폴더면 corrupt).
- 그 밖의 이름은 무시하며 지우지 않습니다.

### 획득(최대 5회 반복)

1. 폴더를 나열해 m = 가장 큰 `<n>.lock`의 n(없으면 0).
2. m > 0이면 세대 m을 판정합니다.

| 세대 m의 상태 | 판정 | 동작 |
| --- | --- | --- |
| `<m>.released`가 일반 파일 | free | 3으로 |
| `<m>.released`가 링크·폴더 등 | corrupt | `LOCKED_BY_OTHER` |
| `<m>.lock`이 일반 파일이 아님(링크·폴더) | corrupt | `LOCKED_BY_OTHER`. 따라가지 않음 |
| 비어 있음·JSON 아님·계약 위반·세대 번호 불일치·32 KiB 초과·UTF-8 아님 | corrupt | `LOCKED_BY_OTHER`(다른 실행이 기록 중이거나 기록 전에 중단됐을 수 있음) |
| `hostname`이 이 컴퓨터와 다름 | foreign-host | `LOCKED_BY_OTHER`. 원격 pid는 확인할 수 없음 |
| 같은 컴퓨터, `process.kill(pid, 0)` 성공·`EPERM`·`ESRCH` 외 오류(자기 pid 포함 — 재진입 없음) | held | `LOCKED_BY_OTHER`. 메시지에 pid·시작 시각 |
| 같은 컴퓨터, `process.kill(pid, 0)`이 `ESRCH` | stale | free와 같이 3으로. **stale 파일을 지우거나 옮기지 않음** |
| 나열 뒤 `<m>.lock`이 사라짐(새 보유자가 정리) | — | 1부터 다시 |

3. `<m+1>.lock`을 O_EXCL로 생성. `EEXIST`면 1부터 다시(다음 회차에 그 파일을 판정). 기록·fsync.
4. **사후 확인**: 다시 나열해 m+1보다 큰 세대가 있으면 진 것입니다. 자기 `<m+1>.released`를 만들고 `LOCKED_BY_OTHER`, fn은 실행하지 않습니다.
5. 이겼으면 정리(최선 노력, 오류 무시 — Windows는 다른 프로세스가 연 파일 삭제를 거부할 수 있음): **자기 세대보다 작은** 세대의 `.lock`·`.released`만 지웁니다.
   현재 최대나 자기 세대 이상은 지우지 않습니다.
6. 생성 뒤 기록·사후 확인이 실패하면 자기 세대 파일을 지우지 않고 `.released`를 남긴 뒤 실패합니다(지우면 이전 세대가 다시 최대가 될 수 있음). 표시도 못 남기면 메시지에 직접 해제 안내.

### 해제(`fn` 뒤 항상)

- 자기 세대 `<n>.lock`의 token이 우리 것인지 읽어 확인합니다. 사라졌거나 바뀌었으면 해제 표시를 남기지 않고 `STATE_CORRUPT`.
- `<n>.released`를 O_EXCL로 만듭니다(token 기록). **해제는 어떤 파일도 지우거나 옮기지 않습니다**(R2 제거). `EEXIST`면 누군가 위조·경쟁한 것이므로 `STATE_CORRUPT`.
- 표시를 만들기 전 나열에서 자기보다 큰 세대가 보였으면(배타성이 깨진 흔적) 표시는 남기고 `STATE_CORRUPT`.
- `fn`이 실패하면 그 오류를 그대로(같은 객체) 다시 던지고, 해제 실패는 `process.emitWarning`(code `AFO_LOCK_RELEASE_FAILED`)으로만 알립니다.
  `fn`이 성공했는데 해제가 실패하면 `작업은 끝났지만 …` `AfoError`를 던집니다. 실행 결과는 저널에 있으므로 "실행되지 않음"으로 해석하면 안 됩니다.
- 보장: `LOCKED_BY_OTHER`·`ROOT_FORBIDDEN`·`STATE_DIR_INVALID`는 `fn` 실행 전에만 나옵니다. 해제 오류는 `fn`이 성공한 뒤에만 던져집니다.

### 보유자가 최대 하나인 이유

가정: 모든 참여자가 이 코드로만 잠금 폴더를 다루고(협조적), 파일시스템이 O_EXCL 생성을 원자적으로 지원하며, 같은 세대 번호의 파일은 한 순간에 하나만 존재합니다.

1. **최대 세대는 지워지지 않는다.** 지우는 곳은 정리(5)뿐이고, 정리하는 프로세스는 자기 세대 g가 존재하는 상태에서 g보다 작은 것만 지웁니다. 해제·실패 처리는 지우지 않습니다.
   따라서 어느 시점에 존재했던 가장 큰 번호 이상의 세대 파일은 이후 항상 존재하고, 최대 세대 번호는 줄지 않습니다.
2. **보유 중인 최대 세대는 free로 판정되지 않는다.** 보유자 P(세대 g)는 사후 확인 전에 내용을 fsync했고, 살아 있으며, 해제 표시는 P만 만듭니다.
   기록 전이면 빈 파일 → corrupt, 기록 뒤면 held. 둘 다 `LOCKED_BY_OTHER`이므로 아무도 g를 근거로 g+1을 만들지 않습니다.
3. **g보다 큰 세대는 P가 보유하는 동안 생기지 않는다.** 세대 k는 k−1을 최대로 보고 free/stale로 판정한 프로세스만 만듭니다. k = g+1은 2에 의해 불가능하고,
   k > g+1이면 k−1 > g가 먼저 존재해야 하므로 귀납적으로 불가능합니다.
4. **두 프로세스가 같은 번호를 보유하지 않는다.** 같은 g를 노리면 O_EXCL로 하나만 생성에 성공합니다. 이미 정리돼 사라진 옛 번호를 느린 프로세스가 다시 만들면,
   그보다 큰 최대 세대가 1에 의해 남아 있으므로 사후 확인(4)에서 반드시 집니다.
5. 그러므로 사후 확인을 통과한 프로세스는 그 순간 최대 세대의 유일한 보유자이고, 3에 의해 해제 전까지 그 상태가 유지됩니다.

stale 인수도 같은 경로입니다. 죽은 세대 m을 여러 프로세스가 동시에 stale로 판정해도 `<m+1>.lock` O_EXCL 생성은 하나만 성공하고, 나머지는 다음 회차에서 m+1(빈 파일 또는 held)을 보고 `LOCKED_BY_OTHER`입니다.

### 자동으로 풀지 않는 잠금과 직접 해제 방법

최대 세대가 corrupt·foreign-host이거나 pid가 살아 있는 held이면 자동 해제하지 않습니다. 사용자는 그 작업 폴더를 쓰는 AFO 실행이
(그 컴퓨터를 포함해) 하나도 없음을 확인한 뒤 오류 메시지에 적힌 **잠금 폴더 `locks/<key>/`를 통째로** 지웁니다. 어느 폴더의 잠금인지는 세대 파일 안의 `canonicalPath`로 확인합니다.
세대 파일 하나만 지우면 이전 세대가 다시 최대가 되어 판정이 바뀔 수 있으므로 폴더 단위로 지웁니다(번호는 1부터 다시 시작). `readRootLock`은 상태만 보고하며 아무것도 바꾸지 않습니다.

### 알려진 한계(수정하지 않음)

- **pid 재사용**: 충돌·재시작 뒤 같은 번호를 다른 프로세스가 쓰면 죽은 세대가 살아 있는 것으로 보입니다. 막는 방향이며 직접 해제가 필요합니다.
- **생성과 기록 사이 중단**(SIGKILL·전원 차단): 빈 최대 세대가 남아 corrupt로 계속 막습니다. 실행 중인 AFO가 없을 때 잠금 폴더를 통째로 지워야 합니다.
  기록 뒤 SIGKILL이면 다음 획득자가 pid가 없음을 확인해 다음 세대로 넘어갑니다.
- **다른 컴퓨터**: 공유 상태 폴더에서 다른 hostname의 세대는 pid를 확인할 수 없어 직접 해제가 필요합니다. 이 컴퓨터의 이름이 바뀌어도 자기 세대가 foreign-host로 보여 막힙니다.
- **겹치는 루트**: 한 폴더와 그 하위 폴더는 device·inode가 달라 서로 다른 잠금이며 서로 막지 않습니다. 각 작업의 no-clobber 이동과 실행 직전 재검증이 그 경우의 보호 장치입니다.
- **inode 재사용**: 폴더를 지우고 다시 만들면 새 폴더가 예전 키를 받을 수 있습니다. 새 폴더가 같은 잠금으로 묶일 뿐이라 배타성을 해치지 않습니다.
- **협조적 잠금**: AFO가 아닌 프로그램, 잠금 폴더를 손으로 고치는 경우(실행 중 폴더 삭제·위조 표시), O_EXCL을 보장하지 않는 네트워크 파일시스템에서는 위 논증이 성립하지 않습니다.
  잠금을 거치지 않는 파일 변경은 실행 직전 재검증이 따로 막아야 합니다.
- 세대 파일과 표시가 남습니다(직전 세대 1–2개와 진 프로세스의 옛 번호). 다음 보유자가 정리하며 크기는 각 수백 바이트입니다.

### 검증

```text
Issue / PR / Commit: #13(1부 루트 잠금) / PR #30 / 재설계 커밋은 8a00c24 위 (기준 origin/main 20209d6)
Environment: macOS 27.0.1 (26A434) arm64, 실물 Mac(이 Mac), Node v24.18.0, npm 11.16.0. temp 볼륨은 대소문자 구분 없음
Fixture: 각 테스트가 createFixture(mkdtemp(os.tmpdir()/afo-test-*))로 만든 state*/·bin/·work/·other/·log/ 폴더와 그 안의 링크만 사용, t.after로 삭제
Steps or exact commands (재설계 뒤):
  npm run typecheck                                                  (exit 0)
  npm test                                                           (tests 104, pass 102, fail 0, skipped 2, todo 0; exit 0)
  node --test dist/tests/lock.test.js ×10 순차                         (매회 tests 15, pass 15, fail 0, skipped 0)
  node --test --test-name-pattern=stress dist/tests/lock.test.js ×6   (매회 pass; 8개 × (stale 20회 + free 4회), 보유자 ≠1인 회차 0)
  AFO_LOCK_STRESS_N=3  AFO_LOCK_STRESS_TRIALS=40 (같은 명령)            (보유자 ≠1인 회차 0 / 44)
  AFO_LOCK_STRESS_N=16 AFO_LOCK_STRESS_TRIALS=20 (같은 명령)            (보유자 ≠1인 회차 0 / 24)
  변이 검사: dist의 lock.js에서 사후 확인을 끄고 빈 최대 세대를 free로 보게 바꾸면 stress가 실패(trial 6: 진 쪽 fn 실행) — 검사가 이중 보유를 잡는다는 근거. 이후 재빌드
  verifier의 tests/verify-13-lock.test.ts(수정하지 않음)를 임시 복사·--noCheck 컴파일해 실행: 옛 API(문자열 키)를 써서 C1–C9는 첫 잠금 호출에서
    ROOT_FORBIDDEN으로 실패(8 fail), R1/R2/R4는 todo, R3 todo 검사는 통과. 어댑터를 새 API로 바꾸는 것은 verifier 몫. 임시 복사본은 지움
Verification level: Unit-verified + macOS 실물에서 실제 자식 프로세스(process.execPath) 동시 실행·SIGKILL 검사. Windows: 미검증(CI 대기)
```

skipped 2개는 기존의 실제 OS 휴지통 검사(`AFO_REAL_TRASH_TEST=1`에서만 실행)이며 이 작업과 무관합니다.

| 검사(`tests/lock.test.ts`) | 근거 |
| --- | --- |
| 실제 자식 A 보유 중 자식 B는 종료 코드 3·`ERROR LOCKED_BY_OTHER`이고 아무 파일도 만들지 않음, A 해제 뒤 `1.lock`+`1.released`, 자식 C가 세대 2 획득·해제하며 세대 1 정리 | 종료 코드·stdout·폴더 목록 |
| 두 자식이 같은 폴더를 다른 표기(링크를 거친 부모 / 직접)로 받아 각자 realpath·lstat(bigint)로 대상 계산: 두 번째는 `LOCKED_BY_OTHER`, 키 동일. 대소문자만 다른 표기도 같은 키(대소문자 구분 없는 볼륨일 때만) | 종료 코드·키 |
| 다른 폴더·하위 폴더·device만 다른 대상은 다른 키, 다른 폴더끼리 서로 막지 않음 | 키·종료 코드 0 |
| 같은 프로세스 중첩·동시 두 호출: 하나만 실행, 나머지 `LOCKED_BY_OTHER`, `fn` 미실행 | 실행 횟수 1 |
| SIGKILL된 자식의 세대 1(죽은 pid) → `readRootLock` stale → 부모가 세대 2로 인수·`fn` 실행, 세대 1 정리 | 파일 내용·폴더 목록 |
| **stress**: 실제 자식 8개가 stale 최대 세대(이전 해제 세대·모르는 파일 포함)를 동시에 인수 20회 + 빈 폴더 4회. 매회 보유자 정확히 1, S/E 로그 겹침 없음, 진 쪽 fn 미실행, 종료 코드 0 하나·3 일곱, 끝나면 free, 모르는 파일 보존 | 공유 S/E 로그·종료 코드 |
| **사후 확인**: 세대 1 생성 직후 더 새 세대 2가 생기는 순서를 fs `open` 감싸기로 고정 → `LOCKED_BY_OTHER`, `fn` 미실행, 자기 `1.released`만 추가, 세대 2 그대로 | 폴더 목록 |
| **해제 빈틈**: A 해제 뒤 자식 C가 세대 2 보유, 옛 번호 `1.lock`이 다시 생겨도 자식 D는 `LOCKED_BY_OTHER`, C의 세대 2 바이트 그대로, 해제는 표시만 추가 | 바이트·폴더 목록 |
| 살아 있는 자식 pid의 손으로 쓴 세대 7: `LOCKED_BY_OTHER`(pid·시작 시각·잠금 폴더 포함), 바이트 그대로, 자식 종료 뒤 stale 보고만, 다음 획득은 세대 8 | 바이트 비교 |
| 다른 hostname(죽은 pid)·빈 파일·잘린 JSON·필드 누락·추가 필드·canonicalPath 없음/상대·generation 없음/파일 이름과 다름·다른 버전·32 KiB 초과·잘못된 UTF-8: 모두 `LOCKED_BY_OTHER`, 바이트 그대로, 새 세대 없음 | 바이트·폴더 목록 |
| 세대 파일 자리의 심볼릭 링크·폴더, 해제 표시 자리의 링크: 따라가지 않고 free로 보지 않음 | lstat·대상 바이트 |
| `locks`나 `locks/<key>`가 일반 파일·폴더 링크: `readRootLock`·`withRootLock` 모두 `STATE_CORRUPT`, 링크 대상 폴더에 아무것도 생기지 않음 | readdir |
| `fn` 오류 객체·문자열 거부값 그대로 전달, 성공 값 반환, 매번 해제 표시 | 동일성·폴더 목록 |
| `fn` 중 token이 바뀌면 표시를 남기지 않고 `STATE_CORRUPT`; 세대 파일이 사라지면 `STATE_CORRUPT`; 위조 표시가 먼저 있으면 `STATE_CORRUPT`; `fn` 실패 시 `fn` 오류 + 경고 `AFO_LOCK_RELEASE_FAILED` | 바이트·경고 code |
| 잘못된 대상 16종 → `ROOT_FORBIDDEN`; 상대·`./`·빈·NUL stateDir → `STATE_DIR_INVALID`; 상태 폴더·현재 폴더에 아무것도 생기지 않음 | readdir·존재 확인 |

Windows의 `process.kill(pid, 0)`·`O_EXCL`·열린 파일 삭제 거부·심볼릭 링크/junction 권한은 이 Mac에서 확인할 수 없습니다. 폴더 링크는 Windows에서 junction으로 만들고 `EPERM`이면 명시적 skip합니다.
이 테스트들은 `os.homedir()`에 의존하지 않습니다(Windows에서 가짜 홈은 `HOME`이 아니라 `USERPROFILE`로 지정해야 함).
