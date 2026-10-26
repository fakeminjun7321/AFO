# 읽기 전용 엔진 첫 구현 검증

대상: #19, `feat/read-only-engine`. 날짜: 2026-10-26.
이 기록은 읽기 전용 CLI의 범위이며 데스크톱 앱의 전체 사용자 경로·파일 정리 실행 검증이 아닙니다.

## 구현한 범위

- strict 런타임 계약, 명시적으로 선택한 폴더의 스캔과 제외/오류/한도/취소 표시
- 확장자 기반 분류, 크기 후보의 streaming SHA-256 중복 확인
- 참고 메타데이터 규칙 제안, 명시적으로 선택한 규칙 확인, JSON 재입력
- 기존/예정 목적지의 이름·대소문자·Unicode·파일/폴더 충돌을 검토 상태로 표시
- 별도 CLI 프로세스의 미리보기, 읽기 전용 결과와 논리 크기 표시

## 로컬 실행 환경과 결과

환경: 실제 macOS 27.0.1, arm64, Node.js v24.18.0, npm 11.16.0.

```text
npm run typecheck  -> exit 0
npm test          -> exit 0
tests 31 / pass 31 / fail 0 / cancelled 0 / skipped 0 / todo 0
```

검사는 `tests/contracts.test.ts`, `engine.test.ts`, `scanner.test.ts`, `cli.test.ts`입니다.
독립 manifest는 숨김·제외 파일을 포함해 파일 경로·내용 SHA-256·크기·수정 시각과 디렉터리/링크를 기록하고 실제 실행 후 대조했습니다.
CLI 검사는 실제 자식 프로세스에서 제안→확인→프로필 JSON 재입력→미리보기→새 프로세스 재호출을 수행했습니다. JSON 저장은 테스트가 사용자의 명시적 내보내기를 모사한 것으로 앱 내 자동 저장 검증이 아닙니다.

| 수준 | 확인 범위 |
| --- | --- |
| Implemented | 엔진·읽기 어댑터·CLI·계약·테스트·양 OS CI 정의 |
| Unit-verified | 위 31개 검사와 타입 검사, 실제 합성 폴더 통합 검사 |
| Physical-device-verified | 이 Mac의 합성 폴더에서 읽기 전용 CLI 경로와 원본 보존 |
| Not verified | Windows 실물, 데스크톱 UI, 쓰기 승인, 이동·삭제·복구, 앱 내 프로필 저장, 실행 하네스, 설치/배포 |

CI 정의의 Windows/macOS hosted runner 결과는 PR checks에서 확인하며 VM/CI 범위로만 해석합니다. Windows의 POSIX chmod 사례는 ACL 검증으로 대체할 수 없어 해당 테스트를 명시적으로 건너뜁니다. Windows 실제 ACL·placeholder·전체 reparse 기능은 후속 검증 대상입니다.

## 남은 한계

초기 규칙 제안은 서로 다른 파일 2개 이상의 근거를 요구하는 보수적 휴리스틱입니다. 실제 사용자 데이터의 정확도·성능은 측정하지 않았습니다.
현재 스캔 상한은 포함 파일 10,000개, 깊이 32입니다. 전체 디스크 탐색기·대규모 파일 성능·UI 응답성을 검증한 결과가 아닙니다.
경로 검사와 읽기 사이의 모든 악의적 파일 교체 경쟁을 막는 OS sandbox라고 주장하지 않습니다. 실제 쓰기 계층은 플랫폼 기술검증과 독립 승인/저널 계약이 필요합니다.
미리보기의 `move`와 중복 후보는 실행/삭제 승인이 아닙니다. 실행 API 자체가 없고, `--execute`와 삭제 명령은 오류로 거부합니다.
