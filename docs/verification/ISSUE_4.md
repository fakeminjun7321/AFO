# #4 공용 계약·상태 저장·fixture 검증

날짜: 2026-10-26. PR: [#23](https://github.com/fakeminjun7321/AFO/pull/23).
대상: `52aa45c`에 `main`의 `35f934b`를 병합한 `69a307d`.
이번 수정은 CI 충돌 해결과 누락된 검증 기록 보완입니다. 제품 코드·계약·테스트는 변경하지 않았습니다.

## 환경과 실행 결과

- macOS 27.0.1 (26A434), arm64, 실제 Mac 1대, Node v24.18.0, npm 11.16.0.
- 새 전용 worktree에서 `npm ci --ignore-scripts --no-audit --no-fund`: 종료 0.
- `npm test`: 엄격 TypeScript 빌드 성공, 69개 중 67개 통과·2개 건너뜀·실패 0, 종료 0. 두 skip은 실제 휴지통 검사입니다.
- CI와 같은 명령으로 다시 실행:

```sh
AFO_REAL_TRASH_TEST=1 node --test --test-reporter=spec --test-reporter-destination=stdout --test-reporter=tap --test-reporter-destination=/tmp/afo-pr23-revision-results.tap dist/tests/*.test.js
```

결과: **69개 통과, 실패 0, 건너뜀 0, 종료 0**. spec 출력과 TAP 파일의 테스트 수가 일치했습니다.
모든 파일 작업은 테스트가 새로 만든 합성 temp 폴더 안에서 수행했습니다.
휴지통에는 합성 파일 2개만 보냈으며 전체 휴지통 비우기나 Finder 조작은 하지 않았습니다.
`V3-12`는 해당 파일이 `~/.Trash/`에 크기 32바이트로 존재하는 것까지 확인했습니다.

## 확인한 범위

| 영역 | 실제 확인 |
| --- | --- |
| 계약 | grant 범위·파일 식별 필수 필드, 목적지·keeper·삭제 모드·요약 일관성, 승인 ID 정렬·유효 기간·프로필 버전, 저널·결과의 상태별 필드, 잘못된 자료형·장치 경로 거부 |
| 상태 저장 | OS별 상태 경로 결정, 실제 경로 기준 작업 루트 겹침 거부, JSON 교체·재읽기, 잘못된 값의 저장 거부와 이전 내용 보존, temp 파일 정리, 손상·과대·비 UTF-8 파일 거부 |
| 저널 | 검증한 항목 append 후 재읽기, 잘린 줄·다른 run ID·역순 seq·잘못된 계약 구분, 링크 경로 쓰기 거부 |
| fixture | 새 temp 루트만 생성, 경로 탈출 거부, 정리 후 부재, 독립 manifest로 추가·삭제·내용·크기·수정 시각·이동 해시 비교 |
| CLI | 실제 자식 프로세스로 규칙 제안→선택 확인→재로딩→미리보기, 원본 manifest 보존, 오류 입력 종료 코드 1·정상 종료 코드 0 |
| OS 어댑터 | macOS에서 실제 이동·덮어쓰기 거부·일반 파일 삭제·휴지통·링크 거부·이동 중간 상태 분류. 상세 사례는 [#3 기록](ISSUE_3.md) |

## 검증 수준과 남은 조건

- **Implemented / 구현**: 공용 계약, 상태 저장, fixture 도구, 두 OS CI 설정이 존재합니다.
- **Unit-verified / 단위 검증**: 위 커밋의 69개 검사가 통과했습니다. 스키마 검사는 승인 권위나 실행 계층의 안전성을 증명하지 않습니다.
- **Physical-device-verified / 실제 하드웨어 검증**: 이 Mac의 합성 파일에 대한 CLI 읽기 전용 경로와 어댑터·상태 저장 단위만 확인했습니다. 전체 파일 정리 사용자 경로는 아닙니다.
- **Simulator-verified / CI 검증**: 이번 push의 Windows·macOS hosted runner 결과는 PR checks에서 별도로 확인합니다. 로컬 결과로 대신하지 않습니다.
- **Not verified / 미검증**: Windows 실물, 쓰기 CLI·승인 서비스·루트 잠금·저널에 결합된 실행·프로세스 종료/재시작 복구·전원 장애 내구성은 이 기록에서 검증하지 않았습니다. 쓰기 CLI와 실행 서비스는 후속 이슈 범위입니다.
- 조부모 경로 링크를 통과하는 어댑터 한계(`V3-11`), Node 경로 검사와 변경 사이의 경쟁, Windows 휴지통 거부 조건의 실물 재현은 남아 있습니다. 전체 제품 준비 완료나 #3·#4의 모든 완료 조건 충족으로 해석하지 않습니다.

`main` 병합으로 중복 타입 검사 제거·이전 실행 취소를 유지하면서 PR의 실제 휴지통 env 설정과 TAP 실패 annotation을 보존했습니다.
