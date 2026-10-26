# #6 스캔·제외·취소, #7 분류·중복 독립 검증

역할: verifier. 날짜: 2026-10-26. 대상은 `origin/feat/6-7-scan-classify`의 `1f17428`(main + #4 후속 PR #26 위)입니다.
검증자는 제품 코드(`packages/`, `apps/`)와 builder 파일을 수정하지 않았고 `tests/verify-6-7.test.ts`와 이 문서만 추가했습니다.
기대값은 손으로 쓴 표입니다. 제품의 확장자 표·제외 코드 목록을 import해 기대값을 만들지 않았습니다(설명 문구 존재 확인에만 `skipCodeDescriptions`를 읽음).

```text
Issue / PR / Commit: #6, #7 / PR 없음(미생성) / 대상 1f17428, 검증 브랜치 verify-6-7(로컬, push 안 함)
Environment: macOS 27.0.1 (26A434) arm64, 실물 Mac, Node v24.18.0, npm 11.16.0, uid≠0. temp 볼륨 APFS(대소문자·정규화 구분 없음)
Fixture and baseline manifest: 모든 파일은 realpath(os.tmpdir())/afo-test-* 아래 새 mkdtemp 폴더. 홈 관련 사례는 HOME을 temp 폴더로 바꾼 가짜 홈.
  baseline = 검증자 oracle(모든 항목의 mode·inode·nlink·size·mtimeNs·ctimeNs·sha256, 링크는 대상 문자열, atime 제외, 링크·FIFO 미개방)
Steps or exact commands:
  git checkout -b verify-6-7 1f17428
  npm ci --ignore-scripts --no-audit --no-fund && npm run typecheck && npm test            (검증 테스트 추가 전)
  npm run typecheck && npm test                                                             (tests/verify-6-7.test.ts 추가 후)
Observed files / hashes / journal / exit status: 아래 표. 이번 범위는 읽기 전용이라 journal 없음
Passed / Failed / Not run: 아래 완료 조건 표
Verification level: Unit-verified + macOS 실물 temp 파일 검사(Physical, 이 Mac). Windows 미검증(CI 대기). CI(VM) 미실행
Not verified and reason: Windows 전체(이 Mac에서 불가), OTHER_VOLUME(두 번째 볼륨을 만들지 않음), 실제 iCloud dataless 파일(희소 파일 휴리스틱만 확인)
Release blocker and unblock condition: 데이터 손실·루트 이탈 결함은 없음. 결함 2건(V67-1, V67-2)은 fail-closed라 출시 차단은 아니나 #8 서비스 전에 수정 권장
```

## 실행 결과

| 단계 | 명령 | 종료 코드 | 결과 |
| --- | --- | --- | --- |
| 재현(1f17428) | `npm ci --ignore-scripts --no-audit --no-fund` | 0 | 4개 패키지 설치 |
| 재현(1f17428) | `npm run typecheck` | 0 | 오류 없음 |
| 재현(1f17428) | `npm test` | 0 | tests 118, pass 116, fail 0, skipped 2(실제 휴지통), todo 0 — builder 보고와 일치 |
| 검증 추가 후 | `npm run typecheck` → `npm test` | 0 / 0 | tests 142, pass 137, fail 0, skipped 2, todo 3 (verify-6-7: 24개, 그중 todo 3은 아래 결함 재현) |
| 실행 후 확인 | `$TMPDIR/afo-test-*` 잔여 | — | 이 테스트가 만든 잔여 없음. `afo-test-locked.txt`가 든 폴더 2개가 있으나 이 브랜치의 테스트에 없는 이름이며(동시에 실행 중인 다른 세션 추정) 손대지 않음 |

결함 재현 테스트는 `{ todo }`로 표시해 실행은 되지만 전체 `npm test`를 실패시키지 않습니다(#4 검증과 같은 방식). 결함이 고쳐지면 todo를 지우고 통과해야 합니다.

## 완료 조건별 판정 — #6

| 완료 조건 | 판정 | 근거(테스트) |
| --- | --- | --- |
| 참고 폴더 읽기 모드 분리, 구조·이름·확장자만 반환 | PASS | V67-F1: chmod 000 파일도 이름·확장자로 나옴(내용 미개방), 항목 키는 `relativePath`·`extension`뿐, size/inode/sha256 없음. V67-R5: scope 교차 사용 거부 |
| 참고 파일은 이동·삭제 대상 제외, 루트 겹침 검사 | PASS | V67-F2: 참고⊂작업, 작업⊂참고, 같은 폴더, 저장 프로필만으로 재분석 4가지 모두 참고 파일은 `keep/PROTECTED_REFERENCE`, 목적지 null, 중복 후보·목적지·largeFiles에 없음 |
| RootGrant 안만 읽음 / 홈·디스크 루트·OS 경로·앱 번들·개발 프로젝트·링크 루트·파일 루트 거부 | PASS | V67-R1: 가짜 홈, 홈/Library(하위 포함), 홈 안 프로젝트(하위 포함), `/`, `/System`, `/System/Library`, `/usr/bin`, `/Library`, `/private/var`, `/Users`, `/Volumes`, `/tmp`, `/private/tmp`, `/Applications`, `.app`·대문자 `.FRAMEWORK` 내부, `.git`·`Package.swift` 프로젝트와 하위, 폴더 링크(끝 `/` 포함), 파일, 없는 경로, 빈 문자열, NUL 모두 work·reference 둘 다 거부. 홈의 dotfiles `.git`은 홈 안 일반 폴더를 막지 않음 |
| `\\?\`, `\\.\` 경로 거부(CARRYOVER) | PASS(macOS만) | V67-R1. macOS에서는 상대 이름이라 "없음"으로 거부됨. Windows 의미의 검사는 미검증 |
| 비정규 `/a/../b` 거부(CARRYOVER) | **FAIL** | V67-R2 → 결함 V67-1 |
| 발급 grant의 실제 루트 식별 일치 | **FAIL** | V67-R3, V67-R3b → 결함 V67-2(fail-closed) |
| dev/inode 교체·링크 교체·스캔/해시 중 교체 후 거부 | PASS | V67-R4: 같은 경로에 다른 폴더 → `FILE_CHANGED`(scanRoot·readReference·verifyGrant), 원래 폴더를 가리키는 링크 → 거부, 원위치 복구 시 다시 유효, 해시 중 교체 → 거부 |
| 다른 scope/세션·다른 프로세스·위조 grant 거부 | PASS | V67-R5: 손으로 만든 정확한 dev/inode/경로 + salt 없는 id 재계산, 무작위 id, 필드 1개 수정(id 유지), 대문자 id, 추가 키, scope 바꿔치기 모두 `ROOT_FORBIDDEN`. 자식 프로세스가 발급한 grant는 이 프로세스에서 거부 |
| 링크·junction·하드링크·지원 안 하는 cloud placeholder 제외 | PASS(macOS) | V67-S1: 파일 링크·폴더 링크·루트 밖 링크 `LINK`(외부 트리 미노출), 하드링크 두 이름 모두 `HARDLINK`, 희소 파일(st_blocks=0) `CLOUD_PLACEHOLDER`. junction·Windows cloud 태그는 미검증 |
| FileSnapshot과 포함/제외/오류/취소, 제외 이유 설명 | PASS | V67-S1 손 작성 표(HIDDEN, DEV_PROJECT×3, APP_BUNDLE, SYSTEM_PATH×2, HARDLINK×2, LINK×3, UNSUPPORTED_NAME×5(`CON.txt`, `a:b.txt`, `back\slash.txt`, 끝 공백, 끝 점), NOT_REGULAR(FIFO), CLOUD_PLACEHOLDER)와 정확히 일치. 모든 테스트의 모든 제외 항목에 코드·한국어 reason·한국어 설명 존재. 의도적 제외만 있으면 `complete: true` |
| 접근 거부·삭제 중·잠긴 파일·한글·공백·이모지·빈 폴더에서 정확한 부분 결과 | PASS | V67-S2(NFD 폴더·파일 바이트 보존, NFC, 공백, 이모지, 빈 폴더, 0 B 파일, size/inode/mtime 실제 값 일치), V67-S3(깊이 0/1, 개수 3/5 정확), V67-S4(chmod 000 폴더 `READ_FAILED/EACCES`, chmod 000 파일은 목록에 있고 해시만 `HASH_FAILED/EACCES`, `chflags uchg` 파일은 정상 해시·중복 판정), V67-S5(스캔 중 파일·폴더 삭제 → 그 두 항목만 `READ_FAILED/ENOENT`, 나머지 정확) |
| 작업 큐·제한된 동시성·진행률·취소 | PASS | V67-P1(스키마 유효, scan→hash 순서, 폴더당 1회, 카운터 단조 증가, 파일 중간 이벤트, 최종 3/3·9 MiB), V67-P2(스캔 중 취소: 기본 AbortError+CANCELLED, partial은 정확히 `d0/f.txt`만, 결과 후 50 ms 동안 이벤트 없음, 미리 취소된 signal은 진행 이벤트 0회), V67-P3(해시 중 취소: 완전히 읽은 첫 파일만 정확한 sha256, 나머지 null, 이후 이벤트 없음, 입력 스캔 불변). "CLI/GUI를 막지 않는" worker 분리는 이번 범위에서 측정하지 않음 |
| 스캔 전후 baseline manifest 동일 | PASS | V67-P4 외 모든 실물 테스트: scanRoot·hashCandidates(동시성 8)·readReference·analyzeRoot 전후 oracle 동일(mtime·ctime·inode·mode·nlink·내용, atime 제외) |
| OTHER_VOLUME 제외 | NOT-RUN | 두 번째 볼륨(디스크 이미지 마운트 등)을 만들지 않음. builder도 테스트 없음 |
| Windows(ACL·junction·`\\?\`·예약명·cloud) | NOT-RUN | 이 Mac에서 불가, CI 대기 |

## 완료 조건별 판정 — #7

| 완료 조건 | 판정 | 근거(테스트) |
| --- | --- | --- |
| #18 결합 인터페이스(명시 수정 > 확인 규칙 > 기본), 참고 파일 비삭제, 습관으로 불필요 추정 안 함 | PASS | V67-C3: override > confirmed personal > default, draft·disabled 무시, 미리보기 행동은 move/keep/review뿐·`executionAvailable: false`. V67-F2(d) 확인 규칙 적용과 참고 파일 보호 동시 확인 |
| 기본 규칙·규칙 버전, 결정적 결과와 이유, 모호한 파일은 검토 | PASS | V67-C1: 손 작성 20행 표(대소문자 확장자 `.PpTx`·`.JPEG`·`.MOV`·`.ZIP`·`.EXE`, 내부 점 `v1.2.pdf`, 확장자 없음 2, 이중 확장자 2, 모르는 확장자 2, 이미 정리 2) 실제 파일에서 일치, 모든 이유 한국어, `classificationVersion` 존재. 동시성 1·8 각 2회 미리보기 완전 동일. V67-C2: 기존 파일·같은 이름·대소문자만 다른 목적지는 모두 review |
| 크기 후보 → streaming 해시, 이름만 같은 파일은 중복 아님 | PASS | V67-D1(같은 이름 다른 내용·같은 크기 다른 내용 → 아님, 다른 이름 같은 내용 → 중복, 고유 크기·빈 파일은 읽지 않음, 3개 그룹), V67-P1·P3(파일 중간 진행 이벤트, 부분 결과 해시 정확) |
| 그룹마다 최소 한 원본 유지, 남길 원본 변경 계약 | PASS | 모든 미리보기에 keeper 불변식 검사(V67-S4·P4·F2·D1·D3·D4). V67-D3: chooseKeeper 성공(입력 불변, id 변경, 합계 재계산, 후보 일부 지정), 그룹 밖·없는 경로·대소문자 변형·keeper 자신·후보 중복·보호 파일·없는 그룹 → `KEEPER_INVALID`, keeper가 후보에 든 변조 미리보기 → 스키마 거부 |
| 빈 파일·대소문자 확장자·동일 이름 다른 내용·다른 이름 같은 내용·중간 변경·읽기 실패·큰 파일 | PASS | V67-D1, V67-C1, V67-D2(스캔~해시 사이 같은 크기 내용 변경, 읽는 도중 append → 그 파일만 `FILE_CHANGED`, `complete: false`, 그룹 제외, review, `HASH_UNAVAILABLE`), V67-S4(읽기 실패), V67-D3(200 MiB 메타데이터 largeFiles). 큰 실제 파일 streaming 메모리는 builder 32 MiB 테스트가 담당(이번 검증은 3·4 MiB 실물로 중간 이벤트만 확인) |
| 논리·할당·회수 추정 분리, 오래됨·크기는 근거 아님 | PASS | V67-D3 손 계산: 그룹 a 2000/12288/12288, b 500/null/500(할당 미상 → 논리 크기로 추정), c(보호 원본) 600/8192/8192, 합계 3100/null/20980, 한국어 주의 문구. 200 MiB·아주 오래된 파일은 후보 아님, largeFiles는 정보용. V67-D4 실물: 하드링크 두 이름은 그룹·추정에서 제외, 할당 = st_blocks×512 |

## 결함

### V67-1 비정규 `..` 입력이 거부되지 않음 (#6, 낮음)

- 재현: `<root>/a`, `<root>/b` 폴더를 만든 뒤 `issueRootGrant('<root>/a/../b')` → 거부되지 않고 `canonicalPath = <root>/b` grant가 발급됨. 테스트 `V67-R2`(todo).
- 기대: CARRYOVER(#6) "AbsolutePathSchema가 … 비정규 `/a/../b`를 허용함 → RootGrant 발급에서 거부".
- 영향: 결과 경로 자체는 정규화되지만 아래 V67-2의 원인이 됩니다.

### V67-2 발급 grant의 dev/inode가 canonicalPath의 폴더가 아님 (#6, 낮음·fail-closed)

- 원인: `checkRoot`가 `lstat(path.resolve(input))`(문자열로 `..`를 접은 경로)과 `realpath(input)`(링크를 따른 뒤 `..` 적용)을 섞어 씁니다. 중간에 링크가 있으면 두 경로가 다른 항목을 가리킵니다.
- 재현 1(`V67-R3`): `<root>/via → <root>/deep/x` 링크, `<root>/target`와 `<root>/deep/target` 폴더. `issueRootGrant('<root>/via/../target')` → `canonicalPath = <root>/deep/target`인데 device/inode는 `<root>/target`의 값. 이후 `verifyGrant`는 `FILE_CHANGED`.
- 재현 2(`V67-R3b`): 물리 대상 `<root>/deep/ft`가 일반 파일, 문자열 대상 `<root>/ft`가 폴더이면 **일반 파일 경로에 대한 grant가 발급**됩니다(디렉터리·링크 검사는 문자열 대상에만 적용).
- 영향: 사용 시점 `verifyGrant`가 거부하므로 루트 이탈·파일 변경은 없습니다(fail-closed). 다만 "RootGrant = 실제 루트 식별" 계약 위반이고, 사용자는 원인과 무관한 "폴더가 바뀌었습니다" 오류를 봅니다.
- 수정 제안(구현은 builder 몫): `..`·`.` 구성요소가 있는 입력 거부(V67-1), 그리고 `realpath` 결과에 대해 `lstat`을 다시 해 종류·dev/inode를 얻기.

## 관찰(판정 대상 아님, 후속 담당에게)

- `scanRoot`·`hashCandidates`·`analyzeRoot`는 세션 인수를 받지 않아, 같은 프로세스에서 `issueRootGrant(x, { sessionId: '다른값' })`로 만든 grant도 스캔합니다(V67-R5 진단 출력 `true`). 다른 프로세스의 grant는 등록부가 없어 거부되므로 현재 위협은 낮습니다. #8 서비스가 `verifyGrant(…, { sessionId })`를 반드시 호출해야 합니다.
- 알려진 결정 그대로 확인: `.tar.gz`·`.pdf.exe`는 review, 참고 파일은 읽지 않으므로 작업 폴더의 같은 내용 사본과 중복으로 묶이지 않음(V67-F2 `loose.hwp`), 클라우드 휴리스틱은 macOS 희소 파일까지 함께 제외.
- 하위 폴더의 파일이 범주 폴더로 옮겨질 때 하위 구조는 유지되지 않습니다(예: `x/a.pdf` → `문서/a.pdf`). 이번 완료 조건의 위반은 아니며 충돌은 review로 막힙니다(V67-C2).
