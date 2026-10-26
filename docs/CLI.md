# AFO CLI 사용법과 종료 코드

이 문서는 `apps/cli/src/index.ts`에 **구현된** 동작만 적습니다. 현재 CLI는 읽기 전용입니다. 파일 이동·휴지통·영구 삭제 명령은 #8·#10 이후 추가됩니다.

## 명령

먼저 `npm run build`가 필요합니다. 설치·검사 방법은 [DEVELOPMENT.md](DEVELOPMENT.md)를 봅니다.

| 명령 | 하는 일 | 파일 변경 |
| --- | --- | --- |
| `node dist/apps/cli/src/index.js --help` (인수 없음도 같음) | 도움말 | 없음 |
| `... preview <폴더> [--profile <JSON>] [--reference <참고 폴더>] [--json]` | 스캔·분류·중복 후보·미리보기 출력 | 없음 |
| `... suggest-rules <참고 폴더>` | 참고 폴더에서 규칙 후보(draft) JSON 출력 | 없음(출력을 파일로 저장하는 것은 사용자의 셸 리디렉션) |
| `... confirm-rules <규칙 JSON> --select <ID,ID>` | 고른 규칙만 `confirmed`로 바꾼 JSON 출력 | 없음 |

`npm run preview -- <폴더>`, `npm run rules:suggest -- <폴더>`, `npm run rules:confirm -- <JSON> --select <ID>`도 같은 명령입니다.

## 종료 코드

| 코드 | 의미 | 예 |
| --- | --- | --- |
| 0 | 성공. 결과를 stdout에 출력 | `--help`, 정상 `preview`. **스캔이 일부 미완료여도 0**이며 출력의 "스캔 일부 미완료"와 JSON `scanComplete: false`로 구분합니다 |
| 1 | 입력 거부 또는 오류. stderr에 `AFO 오류: <이유>` | 모르는 명령·옵션(`--execute` 등), 없는 폴더, 홈·디스크 루트 같은 거부 대상, 손상된 규칙 JSON |
| 130 | Ctrl+C(SIGINT)로 취소 | 큰 폴더 스캔 중 중단 |

사용법 오류와 입력 거부는 아직 같은 코드 1입니다. 실행 명령이 생기는 #8·#10에서 "승인 없음"·"일부 실패" 등을 구분하는 코드를 추가하고 이 표를 갱신합니다.
검증: `tests/cli.test.ts`의 "documented exit codes" 테스트가 0과 1을 실제 프로세스로 확인합니다. 130은 자동 테스트가 없습니다(미검증).
