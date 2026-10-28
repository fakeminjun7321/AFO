# #18 개인 분류 규칙(엔진·저장 계층) 독립 검증

역할: verifier. 날짜: 2026-10-26. 대상은 `origin/feat/18-personal-rules`의 `9194a85`입니다.
범위는 엔진(`packages/engine/src/rules.ts`·분류 연결)과 저장 계층(`packages/filesystem/src/profiles.ts`)입니다. CLI 연동과 배치 승인 결합(#8)은 범위 밖입니다.
검증자는 제품 코드(`packages/`, `apps/`)와 builder 테스트를 수정하지 않았고 `tests/verify-18.test.ts`와 이 문서만 추가했습니다.
기대값은 손으로 쓴 표입니다. 제품의 확장자 표(`categoryExtensions`)는 import하지 않았습니다.

```text
Issue / PR / Commit: #18 / PR 없음(미생성) / 대상 9194a85, 검증 브랜치 verify-18(로컬, push 안 함)
Environment: macOS 27.0.1 (26A434) arm64, 실물 Mac, Node v24.18.0, npm 11.16.0, uid≠0. temp 볼륨 APFS(대소문자·정규화 구분 없음)
Fixture and baseline manifest: 모든 파일은 realpath(os.tmpdir())/afo-test-* 아래 새 mkdtemp 폴더. 상태 폴더는 테스트마다 그 안의 temp 폴더를
  stateDir 또는 AFO_STATE_DIR로 지정. 이 테스트 프로세스와 자식 프로세스의 HOME은 빈 temp 폴더(가짜 홈).
  baseline = 검증자 oracle(모든 항목의 type·inode·nlink·mode·size·mtimeNs·ctimeNs·sha256, 폴더는 inode·mtime·ctime, 링크는 대상 문자열, atime 제외)
Steps or exact commands:
  git fetch origin && git checkout -b verify-18 9194a85
  npm ci --ignore-scripts --no-audit --no-fund && npm run typecheck && npm test            (검증 테스트 추가 전)
  npm run typecheck && npm test                                                             (tests/verify-18.test.ts 추가 후)
  node --test dist/tests/verify-18.test.js                                                  (단독 실행, 진단 출력 확인)
  변이 확인: 기대 목적지 1개·손상 사례 1개(유효 파일로 바꿈)·revision 비교를 일부러 틀린 사본 → V18-03/06/07/09 실패 확인 후 사본 삭제
Observed files / hashes / journal / exit status: 아래 표. 읽기 전용 미리보기와 앱 상태 파일만 다루므로 journal 없음
Passed / Failed / Not run: 아래 완료 조건 표
Verification level: Unit-verified + macOS 실물 temp 파일 검사(Physical, 이 Mac). Windows 미검증(CI 대기). CI(VM) 미실행
Not verified and reason: Windows 전체(이 Mac에서 불가), CLI 참고 선택·규칙 편집·배치 승인 동시 확인(#18 CLI·#8 범위 밖), 다중 프로세스 동시 쓰기(#13)
Release blocker and unblock condition: 데이터 손실·덮어쓰기·루트 이탈은 관측되지 않음. 결함 F-1은 완료 조건 위반이며 #8(실행 계획)이 이 미리보기를 쓰기 전에 수정 필요
```

## 실행 결과

| 단계 | 명령 | 종료 코드 | 결과 |
| --- | --- | --- | --- |
| 재현(9194a85) | `npm ci --ignore-scripts --no-audit --no-fund` | 0 | 4개 패키지 설치 |
| 재현(9194a85) | `npm run typecheck` | 0 | 오류 없음 |
| 재현(9194a85) | `npm test` | 0 | tests 162, pass 160, fail 0, skipped 2(실제 휴지통), todo 0 — builder 보고와 일치 |
| 검증 추가 후 | `npm run typecheck` → `npm test` | 0 / 0 | tests 180, pass 177, fail 0, skipped 2, todo 1 (verify-18: 18개 = pass 17 + todo 1(F-1 재현)) |
| 변이 확인 | 틀린 기대값 사본 실행 | 1 | 의도한 4개 테스트 실패 → 검사가 공허하지 않음. 사본 삭제 |
| 실행 후 확인 | `~/Library/Application Support/AFO` | — | 테스트 전·후 모두 없음. 가짜 HOME도 비어 있음(V18-16) |
| 실행 후 확인 | `$TMPDIR/afo-test-*` 잔여 | — | 이 테스트가 만든 잔여 없음(`afo-test-state-*` 1개는 이 파일이 쓰지 않는 이름, 손대지 않음) |

결함 재현 테스트는 `{ todo }`로 표시해 실행은 되지만 전체 `npm test`를 실패시키지 않습니다. 고쳐지면 todo를 지우고 통과해야 합니다.

## 완료 조건별 판정

| 완료 조건(#18) | 판정 | 근거(테스트) |
| --- | --- | --- |
| 참고 폴더 선택은 선택 사항, 건너뛰면 기본 분류 | PASS | V18-01: 빈 상태 → `loadProfile = null`, 손 작성 13행 기본 표와 일치, `profileId/profileRevision = null`, 작업·상태 폴더 oracle 불변, 상태 폴더에 아무것도 생기지 않음 |
| 지정한 참고 폴더만, 구조·이름·확장자로 설명 가능한 규칙. 내용 업로드·전체 디스크 탐색·모델 학습 없음 | PASS | V18-02: chmod 000 파일도 이름으로 근거가 됨(내용 미개방), 참고 폴더 안 폴더 링크(바깥 폴더 가리킴)·숨김 폴더는 따라가지 않음, 참고·바깥 oracle 불변. V18-03/04: 규칙 = (확장자, 키워드, 목적지, 근거 파일) 손 작성 표와 정확히 일치. 정적 확인: `packages/`·`apps/`에 네트워크 모듈(`http/https/net/tls/dgram`·`fetch`) 없음, `child_process`는 휴지통 어댑터(`platform.ts`)뿐 |
| 참고 전용 폴더는 쓰기 권한 없음, 참고 기존 파일은 이동·삭제 대상 제외, 목적지는 작업 루트 안 | **FAIL(부분)** | 통과: V18-10(같은 세션, 참고⊂작업·작업⊂참고·같은 폴더, 실시간 grant와 저장 프로필 둘 다), V18-11(재시작 후 자식 프로세스), V18-17(NFD 이름, 대소문자 다른 경로) — 참고 파일은 `keep/PROTECTED_REFERENCE`, 목적지 null, 이동 목적지·중복 후보·largeFiles에 없음, 같은 이름 목적지는 `DEST_CONFLICT`, 일회성 override도 참고 파일을 못 옮김, oracle 불변. 목적지는 작업 루트 기준(`수학/…`, `정리/수학/…` 아님). **실패: 작업 루트 안 참고 폴더 이름 변경 후 원본 4개가 모두 move 제안 → F-1**. 쓰기 API 자체는 아직 없음(#8/#10) |
| 근거·저장 위치 예시를 미리 보여 주고 확인된 규칙만 활성화. 첫 CLI 배치 승인에서 규칙 저장 함께 확인 | PASS(엔진) / NOT-RUN(CLI) | V18-03: 초안은 미리보기에 적용되지 않고 저장 거부(상태 폴더 비어 있음), 비활성 v1 저장 거부, 일부만 확인하면 그 규칙만 적용. 저장 규칙에 근거 예시(≤3)·`evidenceCount`·상대 목적지. CLI 표시·배치 승인 결합은 범위 밖 |
| 명시적 수정 > 확인된 개인 규칙 > 기본 규칙. 증거 부족·규칙 충돌·목적지 부재는 검토 | PASS | V18-07: 일회성 override > 저장 수정(정확한 이름 > 키워드) > 개인 규칙 > 기본. V18-03/04: 파일 1개 폴더·이름이 폴더명과 안 맞는 날짜 폴더는 규칙 없음, 두 키워드 동시 일치는 `RULE_CONFLICT`. V18-07: 저장 수정끼리 충돌도 `RULE_CONFLICT`. V18-05: 목적지 자리가 파일이면·기존 파일과 같은 경로면 `DEST_CONFLICT`, 길이 초과 `DEST_INVALID`, 숨김·`..`·절대·빈 목적지와 `/` 든 이름은 저장 거부. 관찰 O-1 참고 |
| '이후에도 적용'을 고를 때만 규칙으로 저장, 일회성과 구분, 비활성화·초기화 | PASS(엔진·저장) / NOT-RUN(CLI `--remember`) | V18-07: override 분석 전후 상태 파일 바이트·mtime·inode 동일, 다음 분석에서 사라짐. `addCorrection`만 저장, 제거 후 하위 규칙으로 복귀, 재추가 시 같은 ID, 목적지 교체, 초기화 후 기본 분류. V18-06: 규칙 하나 끄기·프로필 비활성화는 미적용(`profileId` null), 다시 켜면 원래 표 |
| 프로필 ID·버전·참고 근거·적용 범위·상대 목적지 로컬 저장, 재시작 후 재현. 오래되거나 깨진 프로필은 복구/재확인 대상 | **PARTIAL** | 통과: V18-11(자식 1 저장 → 자식 2·3 로드·분석 결과 완전 동일, 이 프로세스도 동일), V18-13(저장 파일에 절대 경로·홈·tmp 경로·`/`로 시작하는 문자열·`referenceFiles`·근거 4·5번째·단독/낱개 파일 이름 없음, `referenceRootId = sha256(실제 경로)`, 라벨은 폴더 이름만), V18-09(손상 11종 × 저장/초기화 = 22사례 모두 `corrupt` 보고·규칙 미제공·5개 변경 API 거부·바이트 불변, 명시 저장/초기화 때 원래 항목이 inode 그대로 `corrupt-*.json`으로 1개 보존, 링크 대상 불변). 미흡: "오래된" 판정은 v1 형식뿐이고, 참고 폴더 이름 변경·이동 후에도 프로필이 `confirmed`로 남음(F-1) |
| 규칙 변경은 새 계획·승인에 반영, 기존 승인 유지한 채 목적지 변경 없음. 분류 규칙으로 삭제 필요성 추정 없음 | PASS(엔진 전제) / NOT-RUN(#8 승인 결합) | V18-15: 저장·규칙 끄기·수정 추가·비활성·활성·초기화마다 미리보기 ID가 모두 다르고 `profileRevision` 증가. V18-07: 13번 변경의 revision 순증가, 초기화 후 같은 프로필 ID 재저장도 이전 값 재사용 없음, no-op는 쓰기 없음. V18-08: 7개 변경 API 모두 오래된 `expectedRevision`에 `PROFILE_CHANGED`·쓰기 없음. V18-14: 프로필 유무로 `duplicates`·`largeFiles`·`space` 동일, 행동은 move/keep/review뿐, 빈 파일·오래된 파일은 후보 아님 |
| 참고 원본 보존, 과목별/날짜별 예시, 애매한 파일, 충돌, 루트 겹침·변경, 프로필 손상, 수정 후 재적용·초기화·재시작을 독립 fixture로 검증 | **PARTIAL** | 위 V18-01~17. "루트 변경(참고 폴더 이름 변경)"만 F-1로 실패 |

## 손 작성 기대값 요약

- 과목별 참고 `수학/수학_과제{1,2}.pdf`, `국어/국어_독후감.pdf`, `국어/국어 요약.pdf`, `과학/실험보고서.pdf`(1개), `사진/{a,b}.png`, `메모.txt`, `misc/x.txt`
  → 규칙 정확히 3개: `.pdf+국어→국어`, `.pdf+수학→수학`, `.png→사진`. 새 파일: `수학_과제3.pdf→수학/`, `국어 감상문.pdf→국어/`, `수학국어_통합.pdf→review(RULE_CONFLICT)`,
  `과학_실험2.pdf→문서/`, `스크린샷.PNG→사진/`, `수학/수학_기존.pdf→keep(ALREADY_PLACED)`, `README·data.xyz·report.pdf.exe→review`, `backup.tgz→압축/` 등.
- 날짜별 참고 `2026-09/2026-09-03 회의록.hwp` 등 → `.hwp+2026-09`, `.hwp+2026-10` 규칙. 이름이 폴더명과 안 맞는 `2026-11/` 폴더는 규칙 없음.
  새 파일 `2026-10-22 회의록.hwp→2026-10/`, `2026-10-05.HWP→2026-10/`, `2026-11-02 회의.hwp→문서/`, 두 날짜가 든 이름 → review.

## 결함

### F-1 작업 루트 안 참고 폴더의 이름을 바꾸면 참고 원본이 이동 제안이 됨 (#18, 중간)

- 재현(`V18-12b`, todo): `<base>/work/정리/{수학/수학_과제1.pdf, 수학/수학_과제2.pdf, 국어/국어_a.pdf, 국어/국어_b.pdf}`를 참고로 규칙 확인·저장 →
  `정리`를 `정리2`로 이름 변경 → 저장 프로필로 `<base>/work` 분석.
- 관측: 네 원본이 모두 `move`, 예: `정리2/수학/수학_과제1.pdf → 수학/수학_과제1.pdf (PERSONAL_RULE)`. `loadProfile`은 여전히 `confirmed`로 재확인 표시 없음. 파일은 그대로(미리보기뿐).
- 원인: 저장 프로필은 참고 폴더를 `sha256(실제 경로)`로만 알아봅니다(`storedReferenceEntries`). 경로가 바뀌면 일치하는 폴더가 없고,
  `정리2/수학`은 작업 루트 기준 개인 폴더(`수학`)가 아니라 `ALREADY_PLACED`도 적용되지 않습니다.
- 기대: #18 "참고한 기존 파일은 이동·삭제 대상에서 제외", "오래되거나 깨진 프로필은 복구/재확인 대상으로 표시", ARCHITECTURE "목적지·규칙 근거가 더 이상 유효하지 않으면 재검토".
- 영향: 지금은 실행 경로가 없어 데이터 변화 없음. #8 이후 배치 승인 화면에 참고 원본 이동이 섞여 나와 사용자가 승인하면 참고 폴더 구조가 무너집니다(이동은 되돌릴 수 있으므로 손실은 아님).
- 수정 제안(구현은 builder 몫): 경로 해시와 함께 참고 폴더의 dev/inode(같은 볼륨 이름 변경에도 유지)를 저장해 인식하거나, 저장한 근거 예시가 작업 루트 안 다른 위치에서 발견되면
  해당 폴더를 보호·검토 대상으로 두고 프로필을 재확인 상태로 보고. 별도의 참고 폴더(작업 루트 밖) 이름 변경은 영향 없음(V18-12a 통과).

## 관찰(판정 대상 아님, 후속 담당에게)

- O-1 "목적지 부재" 해석: 작업 루트에 아직 없는 규칙 폴더(`수학/`)는 생성 예정 목적지로 `move`가 됩니다(기본 규칙의 `문서/`와 같은 방식). 만들 수 없는 목적지(파일과 충돌·길이 초과)만 review입니다. 이슈의 의도가 "폴더가 없으면 검토"라면 결정 기록이 필요합니다.
- O-2 상태 폴더가 작업 루트 안이어도 분석 단계에서 거부되지 않습니다(`assertStateDirOutside`는 `state.ts` 밖에서 호출되지 않음). 실측: `<work>/appstate`를 상태 폴더로 쓰면 `appstate/profiles/active.json`이 작업 파일로 잡히고, `.json` 키워드 저장 수정이 있으면 `데이터/active.json`으로 `move` 제안됩니다. #8 계획 생성·서비스가 `STATE_DIR_CONFLICT`를 강제해야 합니다.
- O-3 일회성 override는 `RelativePathSchema`만 검사해 숨김 폴더(`.숨김/a.pdf`)를 목적지로 받습니다. 저장 수정은 숨김 목적지를 거부하므로 둘이 다릅니다. 참고⊂작업일 때 override로 참고 하위 폴더에 새 이름 파일을 넣는 것은 허용됩니다(같은 이름은 `DEST_CONFLICT`). CLI/#8에서 정책 확인 필요.
- O-4 `expectedRevision`은 "아직 저장된 프로필 없음"을 표현하지 못합니다. 빈 저장소에 `expectedRevision: 0` 또는 `1`을 주면 모두 `PROFILE_CHANGED`. 첫 저장 경합은 막을 수 없고, 프로세스 간 잠금도 없습니다(#13 범위, builder 주석과 일치).
- 확인된 결정 그대로: `.tar.gz`·`.tgz`는 압축(`default-2`), `report.pdf.exe`는 개인 규칙이 있어도 review, 저장 수정 ID는 조건+목적지로 결정적.

## 재검증(2026-10-28)

역할: verifier. 대상은 `origin/feat/18-land`의 `76f2fdf`(PR #47, main `43f8a9f` 위 병합본)입니다. 검증 브랜치 `verify-18-recheck`.
제품 코드(`packages/`, `apps/`)와 builder 테스트는 수정하지 않았고 `tests/verify-18-recheck.test.ts`(R18-01~28)와 이 절만 추가했습니다.
기대값은 손으로 쓴 표이며 제품의 확장자 표를 import하지 않았습니다. 모든 사례는 자체 oracle(inode·nlink·mode·size·mtime·ctime·sha256)로 분석 전후 동일을 확인합니다.

```text
Issue / PR / Commit: #18 / PR #47 / 대상 76f2fdf, 검증 브랜치 verify-18-recheck
Environment: macOS 27.0.1 (26A434) arm64, 실물 Mac, Node v24.18.0. temp 볼륨 APFS(대소문자·정규화 구분 없음). Windows 미검증(CI 대기)
Fixture: realpath(os.tmpdir())/afo-test-* 새 mkdtemp 폴더. 상태 폴더는 그 안의 temp(stateDir 또는 AFO_STATE_DIR). HOME은 빈 temp(가짜 홈)
Steps: git fetch origin && git checkout -b verify-18-recheck origin/feat/18-land
  rm -rf dist && npm run typecheck && npm test                      (검증 테스트 추가 후)
  node --test dist/tests/*.test.js → exit 0 (todo 실패는 종료 코드에 반영되지 않음)
  변이 확인: dist 사본에서 dev/inode 일치 제거 → R18-08 실패, analyzeRoot의 상태 폴더 검사 제거 → R18-15/16/25 실패. 확인 후 다시 빌드
Result: tests 250, pass 245, fail 0, skipped 2(실제 휴지통), todo 3 (verify-18-recheck: 28 = pass 25 + todo 3(F-2 ×2, F-3))
After run: ~/Library/Application Support/AFO 전후 모두 없음, $TMPDIR/afo-test-* 잔여 0개
Verification level: Unit-verified + macOS 실물 temp 파일(Physical, 이 Mac). Windows·CI(VM) 미실행
```

### 수정 항목별 판정

| 항목 | 판정 | 근거(테스트) |
| --- | --- | --- |
| F-1 작업 루트 안 참고 폴더 이름 변경 | PASS | R18-02: `정리→정리2` 뒤 원본 6개(규칙 없는 `메모.txt`·`기타/단독.hwp` 포함) 모두 `keep/PROTECTED_REFERENCE`, `PROFILE_STALE`, 개인 규칙 미적용(새 파일은 `문서/`), `profileId/profileRevision = null`, 중복·큰 파일 후보 없음 |
| F-1 작업 루트 안 다른 위치로 이동 | PASS | R18-03 `보관/2026/정리`: 같은 보호·알림 |
| F-1 복사(새 inode) | PASS | R18-04: 원본과 `정리 사본` 모두 보호, 알림에 `정리 사본` 표시, 중복 후보 없음 |
| F-1 바깥으로 이동 | PASS | R18-05: 작업 루트는 개인 규칙 적용·알림 없음. 옮긴 폴더나 그 상위를 작업 루트로 분석하면 보호 + 알림 |
| F-1 삭제 후 같은 경로에 복원(새 inode, 교차 볼륨 이동 모사) | PASS | R18-06: 경로 ID만 일치 → 보호 + 알림 |
| F-1 근거 예시 파일만 이름 변경 | PASS | R18-07: 폴더 식별 유지 → 보호, 규칙 적용, 알림 없음. R18-08: 폴더·근거 모두 이름 변경 → dev/inode로 인식 |
| F-1 근거 예시 1개/2개가 다른 폴더에 | PASS | R18-09: 1개는 보호 안 함(일반 파일로 규칙 적용), 2개면 그 폴더 보호 + 알림 |
| F-1 초안 뒤 이름 변경, 그 다음 저장(식별 없음) | PASS | R18-10: `referenceRootIdentity` 없음이어도 근거 예시로 보호 + 알림 |
| F-1 저장 때 대소문자·NFD가 다른 경로 | PASS | R18-11: realpath가 실제 이름으로 정규화 → 거짓 알림 없음 |
| stale 분석은 저장소에 쓰지 않음 | PASS | R18-14: 저장 파일 바이트 동일, 상태 `confirmed` 유지 |
| V18-12a 기대값 변경 판정 | **타당** | R18-13: 이름 바뀐 별도 참고 폴더 자체를 작업 루트로 분석하면 규칙이 다루지 않는 파일(`메모.txt`·`기타/단독.hwp`·`영상.mov`)까지 모두 `PROTECTED_REFERENCE`. 이전 기대값 `ALREADY_PLACED`는 규칙 목적지와 우연히 일치한 파일만 지키는 결과였습니다. 경로 ID만 쓰던 방식이라면 나머지 파일은 기본 규칙 이동 대상이었을 것입니다(V18-12b·F-1과 같은 원인, 코드 기준 추론). 바뀌지 않은 원래 폴더는 알림 없이 보호, 무관한 작업 루트에는 규칙 적용·알림 없음 |
| O-2 상태 폴더 겹침 | PASS | R18-15: 작업 안(존재/아직 없는 하위)·같음·작업을 포함·symlink로 작업 안을 가리킴·대소문자 다른 경로·참고 안·참고와 같음·참고 하위 모두 `STATE_DIR_CONFLICT`, 아무것도 만들지 않음. R18-16: `AFO_STATE_DIR`가 작업/참고 안이면 거부, 옵션 없을 때 기본 경로(`HOME/Library/Application Support/AFO`)가 작업 안이면 거부, 분석은 기본 상태 폴더를 만들지 않음. R18-25: CLI `preview` 종료 코드 1, `AFO 오류[STATE_DIR_CONFLICT]` |
| O-3 이번만 override 목적지 | PASS | R18-17: `.숨김`·`보관/.git`·`..`·`../밖`·`./보관`·절대·`C:/x`·역슬래시·`CON`·`nul`·`aux/하위`·`LPT1.txt`·`com9`·빈 값·끝 `/`·끝 `.`/공백·NUL·4096자 초과 23종 거부. `숙제`·`2학기/숙제 폴더`·`a..b`·`console`은 `USER_OVERRIDE` 이동. 참고 원본에 override를 줘도 `keep`. R18-18: CLI `--move` 7종 × (`--remember` 유무) 종료 코드 2, stdout 비어 있음, 상태 폴더 변화 없음 |
| O-4 순차 고정 | PASS | R18-19: 빈 저장소에 `0`은 거부·`null`은 허용, 활성 저장소에 `null` 거부, revision+fingerprint 동시 지정 거부, 손상 파일에 revision/`null` 거부, 다른 손상 파일로 바뀐 뒤 옛 fingerprint 거부, 거부 시 쓰기 없음 |
| O-4 빈 저장소 동시 첫 저장(두 프로세스) | **FAIL → F-2** | R18-20(todo): 8/8 라운드에서 두 프로세스 모두 성공 응답(각각 다른 프로필 ID, 둘 다 revision 2), 저장소에는 하나만 남고 다른 쪽 수정은 사라짐 |
| O-4 손상 파일 위 동시 reset | PASS(보존) / 참고 | R18-21: 8/8 라운드 손상 바이트가 `corrupt-*.json` 1개로 정확히 보존, 최종 empty. 다만 7/8 라운드에서 두 reset 모두 성공 응답(두 번째의 `ENOENT`를 무시) — 결과가 같아 손실은 없음 |
| O-4 손상 파일 위 save와 reset 경쟁 | **FAIL → F-2** | R18-22(todo, 시점 의존): 시작 지연 0–7 ms를 바꿔 가며 8라운드. 실행마다 1~2라운드에서 둘 다 성공 응답·최종 empty(저장했다는 프로필이 사라짐). 손상 바이트는 매번 1개 보존 |
| CLI stale 경고 | PASS / 부분 F-3 | R18-23: 실제 프로세스 `preview`가 `경고:` 줄을 정확히 1개 출력(stdout), 원본은 `[유지] 정리2/…`, 새 파일은 `문서/`, `--json`에 `profileNotice.code = PROFILE_STALE`·`profileId = null`, 저장 파일 바이트 불변. 단 바로 위 줄이 `개인 규칙: 저장된 프로필 적용(revision 2)` → F-3 |
| `.tar.gz`/`.tgz` 공용 기본 표 | PASS | R18-26: 18개 이름에 대해 `defaults.ts`의 `defaultCategory`, `classifyFile`, CLI 프로세스 `preview --json --no-saved-rules`가 손 작성 표와 모두 일치(`archive.tar.gz`·`BIG.TAR.GZ`·`.tgz` → 압축, `report.pdf.exe`·`photo.jpg.gz`·`data.tar.zip`·`a.tar.tgz`·`archive.tar.gz.exe` → review `COMPOUND_EXTENSION`) |
| `report.pdf.exe`는 개인 규칙이 있어도 review | PASS | R18-27: 학습한 `.exe → 프로그램` 규칙이 있어도 review, `setup.exe`만 이동. 학습한 `.gz → 백업` 규칙은 `x.tar.gz`에 적용, `y.tgz`는 기본 `압축/` |

### 결함

#### F-2 프로필 저장소에 프로세스 간 상호 배제가 없어 `expectedRevision: null`/`expectedCorrupt` 고정이 동시 실행에서 지켜지지 않음 (#18/#13, 중간)

- 재현(R18-20): 빈 상태 폴더에서 두 node 프로세스가 같은 시각에 `addCorrection({type:'file-name', name:'p<i>.pdf'}, '보관<i>', { stateDir, expectedRevision: null })`.
- 관측: 8/8 라운드 모두 두 호출이 성공을 반환(서로 다른 `local-*` ID, 둘 다 revision 2). `active.json`에는 하나만 남고 수정 1개뿐 → 다른 쪽 CLI는 "이후에도 적용하도록 저장"이라고 출력했지만 저장되지 않음.
  R18-22: 손상 파일 위 `saveConfirmedProfile(… expectedCorrupt)`와 `resetProfile(… expectedCorrupt)`가 둘 다 성공 응답, 최종 empty(저장 성공이라던 프로필 소실). 손상 바이트 보존은 지켜짐.
- 원인: `current()` 검사와 `writeJsonAtomic` 교체 사이에 잠금이 없음. `setAside`가 `ENOENT`(다른 프로세스가 이미 옮김)를 조용히 성공으로 처리.
- 기대: 패킷 "하나만 성공", CARRYOVER "첫 저장·손상 위 reset 경쟁 고정". 사용자 파일 손실은 없고(앱 상태만), 실행 계층(#8/#10) 이전이므로 출시 차단 여부는 coordinator 판단. 제안: 상태 폴더 `locks/` 아래 프로필 잠금(lock.ts 방식)으로 검사·쓰기 직렬화, `setAside`의 `ENOENT`는 `PROFILE_CHANGED`로.

#### F-3 stale 프로필인데 CLI 사람용 출력이 "저장된 프로필 적용"이라고 표시 (#18 CLI, 낮음)

- 재현(R18-24): 저장 뒤 작업 루트 안 참고 폴더 이름 변경 → `preview <work>`.
- 관측: `개인 규칙: 저장된 프로필 적용(revision 2)` 다음 줄에 `경고: … 개인 규칙을 적용하지 않습니다`. 두 줄이 서로 모순. JSON `profile.source`도 `saved`(단 `preview.profileNotice`와 `profileId: null`로 구분 가능).
- 제안: `profileNotice`가 있으면 profileLine을 "저장된 프로필이 바뀐 참고 폴더 때문에 적용하지 않음(기본 분류, 참고 파일 보호는 유지)"처럼 바꿈.

### 관찰

- O-5 근거 예시 이름 2개가 작업 루트 최상위 구조에 그대로 있으면(R18-12: `수학/수학_과제1.pdf`·`수학/수학_과제2.pdf`, 내용은 다름) 작업 루트 전체가 보호되고 알림이 "작업 폴더 자체"로 나옵니다. 데이터 쪽으로는 안전하지만, 같은 이름의 파일을 우연히 가진 폴더는 정리 대상이 전부 `keep`이 됩니다. 사용자 테스트에서 오탐 빈도를 보고 임계값(2개)·내용 비교 여부를 결정하세요.
- O-6 변이 확인에서 dev/inode 일치를 끄면 R18-02/03(이름 변경·이동)은 여전히 통과합니다. 근거 예시 2개 이상 규칙이 독립 보호망이기 때문이며, dev/inode 경로 자체는 R18-08(근거 이름까지 바꾼 경우)만 단독으로 검증합니다.
- O-7 잘못된 override는 항목 review가 아니라 `analyzeRoot` 전체가 Zod 오류로 실패합니다. CLI는 그 전에 `--move` 형식을 검사해 종료 코드 2로 막으므로 사용자 경로에는 영향 없음.
