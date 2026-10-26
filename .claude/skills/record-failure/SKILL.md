---
name: record-failure
description: 검증 실패, 리뷰 지적, 하네스 위반, 반복 오류에서 배운 점을 docs/harness/failures.md에 기록하고 필요하면 AGENTS.md 알려진 함정과 회귀 테스트로 반영한다. 사이클 중 FAIL·BLOCKED·위반이 생겼을 때 사용.
---

# 실패 기록

1. `docs/harness/failures.md` 표 맨 위에 한 줄을 추가한다: 날짜(KST) · 과업 ID · 증상 · 원인 · 대응(추가한 테스트/규칙) · 상태(해결/미해결).
2. 같은 종류의 실패가 이번이 **두 번째**이면 `AGENTS.md` "알려진 함정" 절에 규칙 한 줄을 추가한다.
3. 기계적으로 막을 수 있는 실패(경로 위반, 금지 명령 등)는 `scripts/harness/` 훅이나 테스트에 반영할 과업을 `task.mjs add`로 만든다(하네스 변경은 사용자 확인 후).
4. 결함을 잡는 회귀 테스트가 필요하면 다음 verifier 호출 때 그 테스트를 `tests/review/<ID>/`에 추가하도록 지시한다.
