---
name: afo-workflow
description: AFO 과업 하나를 HARNESS.md 흐름대로 끝까지 수행한다(작업 패킷 → core-builder/interface-builder 구현 → verifier 독립 검증 → 수정·재검증 → 커밋·PR → Issue 기록 → 5줄 브리핑). 사용자가 OK·진행·다음을 입력하거나 과업 ID·Issue 번호·짧은 과업 지시를 줄 때 사용.
---

# AFO 과업 흐름(coordinator)

메인 세션이 **coordinator**로서 이 절차를 따른다(docs/HARNESS.md "한 이슈를 처리하는 순서"의 실행판).
과업 하나가 끝나면 **멈추고 사용자 OK를 기다린다.** 단일 최신 상태는 GitHub Issue이고, `docs/status/`는 과업 단위 재개용 보조 기록이다(DECISIONS D12).

## 0. 사전 확인

1. `git status --short`, `git branch --show-current`, `git log --oneline -3`. 커밋 안 된 변경이 이전 과업의 잔여물이면 그 과업부터 정리한다.
2. `node scripts/harness/task.mjs status --brief`
3. `docs/status/current-task.json`이 있으면 새 과업을 고르지 않고 그 과업을 멈춘 단계부터 이어서 한다.
4. 담당 Issue와 선행 Issue의 실제 상태를 본다: `gh issue view <n>`(GraphQL이 막히면 `gh api repos/fakeminjun7321/AFO/issues/<n>`). 선행 Issue가 열려 있고 그 결과가 필요하면 시작하지 않는다.

## 1. 과업 선정

- 사용자가 지정한 과업 또는 Issue. 과업이 `tasks.json`에 없으면 `task.mjs add --json '{…}'`로 추가한다(`issues`, `role`, 측정 가능한 `acceptance`, `allowedPaths` 필수).
- 지정이 없으면 `node scripts/harness/task.mjs next`.
- `NEXT 없음`이면 시작하지 않고, 막고 있는 사람 작업을 5줄 형식으로 보고한다.
- `role`이 `human`이면 하지 않는다. `joint`는 에이전트가 할 수 있는 부분만 하고 사람 몫을 보고에 적는다.
- `tier`가 `결정필요`·`제외(MVD-B)`·`후속`인 과업, 또는 아래 "별도 승인" 항목은 시작 전에 무엇을 승인할지 한 줄로 묻고 멈춘다.

## 2. 시작과 작업 패킷

```bash
git switch main && git pull --ff-only          # 기준이 main이 아니면 사용자 지시를 따른다(추측 금지)
node scripts/harness/task.mjs start <ID> --sync   # current-task.json(패킷) + 기준 SHA, Issue에 시작 코멘트
git switch -c <출력된 브랜치>
```

구현 담당에게는 HARNESS.md **작업 패킷 양식**을 채워 전달한다(Issue URL, Role, Base commit, Objective, Owned paths, Acceptance criteria, Verification, Stop conditions, Return). 이슈 번호만 던지지 않는다.

## 3. 구현 담당 호출

- `role`이 `core-builder`이면 core-builder, `interface-builder`이면 interface-builder 서브에이전트. 훅이 과업 role과 다른 담당의 편집을 거부한다.
- 2회차 이후: 직전 verifier 보고서의 "발견한 문제"를 번호 그대로 전달한다.
- 동시 실행 상한은 구현 2개. 같은 경로·공용 계약·lockfile·파일 실행 경로를 건드리는 과업은 직렬로 한다. 병렬 실행용 worktree 모드는 아직 파일럿 검증 전이므로 사용자 승인 없이 쓰지 않는다.

반환을 받으면 coordinator가 직접 확인한다.

```bash
git status --short && git diff --stat
node scripts/harness/task.mjs violations      # 새 기록이 있으면 원인 파악·기록
```

## 4. verifier 호출

```bash
node scripts/harness/task.mjs review <ID>      # 검토 차수 증가, 보고서 경로 출력
```

verifier에는 **과업 ID와 "current-task.json 기준으로 독립 검증하라"만** 전달한다. 구현 담당의 설명이나 coordinator의 판단을 넘기지 않는다.

verifier가 끝나면 coordinator가 확인한다.

1. `docs/reviews/<ID>-r<n>.md`의 마지막 줄 `VERDICT`.
2. coordinator가 직접 `node scripts/harness/run-checks.mjs`를 실행해 `RESULT: PASS`인지 본다. verifier가 PASS라도 자동 검사가 실패하면 FAIL이다.
3. `task.mjs violations`에 새 기록이 없는지.

## 5. 판정

- 모두 통과 → `node scripts/harness/task.mjs result <ID> pass` → 6단계.
- 하나라도 실패 → `node scripts/harness/task.mjs result <ID> fail --note "<원인 한 줄>"`
  - 같은 결함의 수정·재검증은 **2회까지**(HARNESS.md). 출력이 `BLOCKED`(FAIL 3회)이거나 같은 테스트가 같은 이유로 다시 실패하면 멈추고 `task.mjs block <ID> --reason …`, `/record-failure`, 설계·계약 재검토 필요로 보고한다.
  - 그 외에는 3단계로 돌아간다. 사용자에게 묻지 않는다.

## 6. 커밋·PR·기록

```bash
git add <변경 파일>     # git add -A 전에 범위 밖 파일이 없는지 확인
git commit -m "<ID>: <요약> (#<Issue>)" -m "Review: docs/reviews/<ID>-r<n>.md (PASS)" -m "Checks: node scripts/harness/run-checks.mjs → PASS"
node scripts/harness/task.mjs done <ID> --summary "<한 줄>" --tests "<명령과 통과 수>" --commit <SHA> --review docs/reviews/<ID>-r<n>.md [--external-pending] --sync
git add docs/status && git commit -m "<ID>: 상태 기록"
git push -u origin <브랜치>
```

- PR은 `.github/PULL_REQUEST_TEMPLATE.md` 양식으로 연다(`gh api repos/fakeminjun7321/AFO/pulls -f head=<브랜치> -f base=main -f title=… -f body=…`). 검증 수준(구현/단위/VM·CI/실물)과 미검증을 반드시 적는다.
- CI 결과는 `gh api repos/fakeminjun7321/AFO/actions/runs?branch=<브랜치>`로 확인하고 실제 결론만 보고한다.
- Issue 라벨(`status:*`)은 coordinator가 실제 결과에 맞춰 수동으로 바꾼다. Issue를 닫는 것은 사람이 완료 조건을 확인한 뒤다.
- `needsExternalReview` 과업은 `/external-review-packet`으로 패킷을 만들고, 외부 검토 기록 전에는 `--external-pending`을 붙인다.
- 새로 알게 된 함정은 `/record-failure`로 남긴다.

## 별도 승인(“OK”로 승인되지 않음)

PR 병합·main 직접 푸시, 영구 삭제 기능 실행, 실제 사용자 데이터 변경, 큰 구조 변경(공용 계약 재설계·패키지 구조·하네스 정책 변경), 배포, 외부 메시지 전송, 모델·계정·권한·플러그인 설치.

## 7. 브리핑(최대 5줄) 후 멈춤

```
- 완료: <ID 제목> (Issue #n, PR #m)
- 구현: <변경 파일·내용>
- 검증: <run-checks 결과, verifier r<n> PASS, 추가 리뷰 테스트 수, CI 결론>
- 문제: <없으면 없음 / 미검증>
- 다음: <task.mjs next 결과 또는 필요한 승인>
```

**사용자 OK 전에는 다음 과업을 시작하지 않는다.**
