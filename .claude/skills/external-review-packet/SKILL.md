---
name: external-review-packet
description: 사람이 ChatGPT로 외부 독립 검토(계획 10.7)를 할 수 있도록 검토 패킷 마크다운을 만든다. 실행기·계약 과업, 통합 테스트, 릴리스처럼 needsExternalReview 과업이 verifier PASS를 받았을 때 사용.
---

# 외부 검토 패킷 만들기

1. 대상: 과업 ID(또는 ER-1~4). `node scripts/harness/task.mjs show <ID>`로 수용 기준을 가져온다.
2. `docs/reviews/packets/<ID>.md`를 아래 구성으로 쓴다.
   - 목적과 검토 질문 5개 이내(데이터 유실 경로, 경합 조건, 승인 범위 밖 변경, 테스트가 놓친 경우, 모호한 정의)
   - 관련 계획 절 발췌(절 번호와 핵심 문장만)
   - 변경 요약과 `git diff main...<브랜치>`(길면 실행기 핵심 파일만)
   - 테스트 결과: `node scripts/harness/run-checks.mjs` 출력 요약, verifier 보고서 경로·판정
   - 응답 형식 요청: 지적마다 [차단|수정|참고] · 근거 · 재현 방법
3. **넣으면 안 되는 것**: 실제 사용자 파일명·경로, API 키·토큰, 개인정보. 경로는 합성 데이터 이름만 남긴다. 작성 후 `grep -nE "(Users|home)/|Desktop|Documents|Downloads|sk-|ghp_" docs/reviews/packets/<ID>.md`로 확인한다.
4. 사용자에게 "패킷 경로 + 작성자가 아닌 사람이 새 ChatGPT 대화에서 검토 → 결과를 docs/reviews/<ID>-external.md에 기록"을 한 줄로 안내한다. 외부 검토 결과는 자동 테스트를 대체하지 않으며, 지적은 재현 테스트로 확인된 것만 반영한다.
