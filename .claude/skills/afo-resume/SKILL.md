---
name: afo-resume
description: 새 세션에서 AFO 작업을 이어갈 때 저장된 상태(docs/status)와 git·GitHub 상태를 확인하고 마지막으로 멈춘 지점을 찾는다. 세션의 첫 요청이나 "이어서", "어디까지 했지"에 사용.
---

# AFO 세션 재개

1. 상태 확인
   ```bash
   node scripts/harness/task.mjs status --brief
   git status --short; git branch --show-current; git log --oneline -5
   ```
2. GitHub 확인(정본): `gh api 'repos/fakeminjun7321/AFO/issues?state=open&per_page=50' --jq '.[]|[.number,.title,([.labels[].name]|join(","))]|@tsv'`, 열린 PR `gh api repos/fakeminjun7321/AFO/pulls --jq '.[]|[.number,.head.ref,.title]|@tsv'`. 인증이 없으면 "GitHub 미연결"로 적고 로컬 상태만 쓴다. Issue 상태와 `docs/status`가 다르면 Issue를 기준으로 본다.
3. 멈춘 지점 판정
   - `docs/status/current-task.json`이 있으면: 그 과업의 `history` 마지막 이벤트와 git 상태를 보고 단계(구현 중 / 검토 대기 / 판정 대기 / 커밋 대기)를 정한다. 커밋 안 된 변경이 있으면 내용을 확인한다.
   - 없으면: 마지막 완료 과업 다음부터.
   - `docs/status/log.md`에 완료로 적힌 과업은 다시 하지 않는다.
4. 불일치가 있으면(예: 상태는 done인데 커밋 없음) 고치지 말고 사용자에게 한 줄로 알린다.
5. 사용자에게 3줄 이내로 보고한다: 마지막 완료, 현재 과업과 단계, 다음 할 일. 사용자가 OK나 과업 지시를 하면 `/afo-workflow`을 이어서 수행한다.
