# AFO 웹사이트 첫 배포 검증 기록

이 문서는 최초 단일 페이지 버전의 기록입니다. 이후 페이지 분리·Firebase Auth 연동의 현재 상태는 ../README.md를 확인합니다.

날짜: 2026-10-26 (Asia/Seoul). 이슈 #32. 기준 커밋 `1a829825c709c33c08f1fef57f1d83f3c1dc9f5c`. 작업 경로 `apps/website/**`.

## 검증 수준

| 수준 | 실제 확인 범위 |
| --- | --- |
| Implemented | React 페이지, 합성 샘플의 미리보기·기준 변경·초기화, FAQ·메뉴, 반응형 CSS, Firebase Hosting 전용 설정 |
| Unit-verified | 별도의 단위 테스트는 추가·실행하지 않음. `npm run build`의 TypeScript 검사와 프로덕션 번들 생성 통과 |
| Simulator-verified | Firebase **Hosting Emulator**에서 빌드 결과를 제공. 별도 headless Chromium의 실제 DOM·화면·버튼 경로 검사 통과. 모바일은 뷰포트 에뮬레이션이며 iOS/Android OS 시뮬레이터 검증이 아님 |
| Physical-device-verified | 사용자 실제 브라우저 조작·실물 휴대폰 검증은 하지 않음. macOS에서 실행한 headless 검증을 해당 검증으로 확대하지 않음 |

Not verified / 미검증: 실제 계정 로그인·클라우드 규칙 저장·CLI 연결·실제 사용자 파일 변경. 이 사이트의 범위는 소개와 합성 샘플 체험이며 해당 기능을 제공한다고 표시하지 않는다. 공개 정적 사이트 배포와 브라우저 경로는 아래에서 별도로 검증했다.

## 실행과 관측

- `npm run build`: TypeScript 오류 없음, Vite 프로덕션 빌드 성공.
- `firebase emulators:start --only hosting --project demo-afo-website --config firebase.json --non-interactive`: 15175 포트에서 dist 제공. 프로젝트 `demo-`로 실제 클라우드 서비스 호출 차단.
- 숨김 IAB로 초기 페이지·접근성 구조·주요 CTA 앵커 확인. 현재 브라우저 origin 배율 25%에서 캡처가 오류 또는 빈 이미지로 나타나므로 캡처 재시도를 중단하고 **별도 headless Playwright Chromium**으로 시각 검수를 진행했다. 사용자 개인 탭·전경·전역 입력·클립보드·브라우저 줌 설정은 변경하지 않았다. 작업 전용 숨김 탭의 CDP viewport만 임시 조절했다.
- Chromium: 1586×992, 1440×900, 1280×720, 768×1024, 390×844, 320×700. HTTP 200, CSP 헤더, 자체 폰트 로드, 가로 넘침 없음, 페이지/콘솔 오류 없음.
- 실제 클릭 경로: 히어로 CTA → #demo → 분류 미리보기 → 문서 분류 기준을 과목별 정리로 변경 → 보고서 `학교/물리`, 필기 `학교/수업` 확인 → 사진의 `이미지` 분류 유지 → 다시 체험하기 → 확장자 목록과 초기 버튼 복귀.
- FAQ 클릭·Enter 키로 펼침/접힘, 동시에 하나만 열림 확인. 390/320px에서 메뉴 열기 → 사용 방법 선택 → 앵커 변경 및 메뉴 닫힘 확인.
- `browser-results.json`: 여섯 크기 모두 통과. 각 페이지에서 문서·JS·CSS·해당 화면 이미지·폰트 5건만 로컬 요청. 외부 네트워크 요청 0.
- 공개 검증 전 다른 활성 채팅을 읽기 전용으로 확인했다. `파일 정리 시스템 개발`은 Firebase 콘솔의 앱/Auth/DB 설정을 다루며 이 미리보기 채널의 사용자 경로를 검증하는 작업은 관찰되지 않았다. 이 채팅은 별도 채널의 정적 사이트 배포와 검증만 수행했다. 사용자 Chrome·전경 조작은 하지 않았다.
- 이번 채팅의 **AFO 공개 웹사이트 의도적 최상위 탐색: 1회**. 이 페이지의 정적 리소스 포함 실제 관측 요청은 6건(문서·JS·CSS·데스크톱/모바일 이미지·폰트), 콘솔·페이지 오류 0건. 관리자 API 조회와 Hosting 배포 트래픽은 이 웹사이트 탐색 수와 별개다. 부하 검사·반복 탐색·자동 새로고침은 실행하지 않았다.

## 시각 대조

콘셉트와 최종 Chromium 캡처를 `view_image`로 직접 열어 대조했다. 히어로 원본 크기 1586×992로 캡처했으며, 데모·FAQ도 각 콘셉트의 뷰포트 크기로 확인했다.

| 항목 | 콘셉트 / 렌더 근거 | 관찰과 반영 |
| --- | --- | --- |
| 제목·위계 | design/01-hero.png / desktop.png | 초기 HTML 제목이 작아 보여 데스크톱 크기를 약 7vw로 확대. 두 줄·중앙 정렬·주변 여백 유지 |
| 워드마크 | 01 / desktop.png | font-synthesis:none으로 기울기가 사라진 상태를 발견해 실제 글자에 skew를 적용 |
| 팔레트 | 01–03 / desktop.png·demo.png·faq.png | 검정·흰색·주황과 단일 어두운 목록 프레임 유지. 주황 #f4512c를 공통 토큰으로 사용 |
| 이미지 | 01 / desktop.png·mobile.png | 별도 생성한 동일 오브젝트 배경 사용. 모바일 중앙 크롭에서 물체가 사라지는 문제를 발견해 별도 세로 구도의 자산 생성·적용 |
| 표·아이콘·간격 | 02 / demo.png·mobile-preview.png | 6행과 실제 파일명·확장자·크기 유지. 아이콘은 채운 색 심벌과 어두운 내부 기호. 모바일은 목적지를 두 번째 줄로 배치 |
| FAQ·마지막 구역 | 03 / faq.png | 2열 FAQ, 수평 구분선, 주황 띠, 검정 마지막 버튼과 푸터 유지. 네이티브 details 사용 |
| 첫 화면 카피 | design/DESIGN.md 허용 목록 / 실제 DOM | 허용된 제목·메뉴·CTA·원칙 외 새 배지·성과·부제 없음. 모바일은 세 메뉴를 접음 |
| 접근성·동작 | 모바일·DOM·계산 색 대비 | 포커스 표시, 명시적 label, 상태 알림, reduced-motion 반영. 주황 CTA의 흰 문구는 19px 이상/700으로 큰 글자 대비 기준을 적용 |

콘셉트의 정보 구조·색·레이아웃·자산 처리·카피를 실제 렌더와 대조했다. 구현 가능한 프런트엔드 기준으로 시각적 충실도를 확인했다. 생성 이미지의 모든 픽셀·글꼴 자형을 복제했다는 뜻은 아니다.

의도된 차이: 실제 한국어 조판은 자체 호스팅 Pretendard로 구현하며 이미지의 자형·자간을 완전히 복제하지 않는다. 원본 SWSH의 이벤트 자료와 로고·투자·고객 지표는 AFO 내용으로 대체했다. 미리보기 이후 기준 선택·초기화 상태를 보강했다. 사용 방법은 브라우저에서 실제 파일을 선택하는 것으로 오해하지 않도록 로컬 CLI 기준으로 설명한다. 모바일은 별도 세로 이미지와 2줄 표를 사용한다.

## 승인 후 공개 배포

사용자가 이 채팅에서 `website-design` 채널의 7일 공개 배포를 명시적으로 승인했다. 앱 소스 커밋 `813a6a2`, 배포 version `da977dcb8d38cb97`.

- 명령: `firebase hosting:channel:deploy website-design --expires 7d --project afo-hackathon-2026-7321 --config firebase.json --non-interactive`
- 기존 채널 목록은 setup/live뿐이었으며 새 website-design 채널을 생성했다. dist의 8개 파일만 배포했다. Firestore·Auth 배포 명령은 실행하지 않았다.
- URL: https://afo-hackathon-2026-7321--website-design-l2p0zktg.web.app
- 만료: 2026-11-02 20:44:27 Asia/Seoul.
- 실제 공개 주소에서 headless Chromium으로 HTTP 200·CSP·제목·이미지·폰트와 샘플 미리보기→과목별 기준→학교/물리→초기화, FAQ, 390px 모바일을 확인했다. 결과는 `public-results.json`, `public-desktop.png`, `public-mobile.png`.

### 확인된 배포 옵션 누락

기대한 범위는 Hosting 전용이었으나 `hosting:channel:deploy`는 기본으로 Firebase Auth 도메인 추가 및 정리 동기화도 시도한다. `--no-authorized-domains`를 실행 전에 확인·적용하지 않은 것은 옵션 확인 누락이다. CLI는 `Unable to add channel domain to Firebase Auth`와 `Unable to sync Firebase Auth state`를 출력했다. 이후 기존 CLI 인증을 사용한 **읽기 전용** Auth config GET 1회는 `404 CONFIGURATION_NOT_FOUND`를 반환했다. 설치 CLI 소스의 Auth 도메인 추가는 config GET 성공 후 PATCH를 수행하는 구조다. 이 시점에 Auth config가 없는 것을 확인했으며, 실패 경고를 Auth 연결 성공으로 표현하지 않는다.

예방: Hosting만 맡은 후속 배포는 `--no-authorized-domains`를 명시하고, CLI help에서 부수 동작 옵션을 확인한다. 동기화 실패를 이유로 Auth 초기화·제공자 활성화·허용 도메인 수정·재배포는 하지 않았다. 이 예방 절차의 다음 독립 작업에서의 효과는 아직 미검증이다.

## 남은 단계

로그인·규칙 동기화·로컬 CLI 연결은 각각 별도 통합과 실제 결과 검증이 필요하다. Hosting의 성공이 Auth·Firestore·로컬 파일 처리의 성공을 증명하지 않는다. 본 채널은 만료되는 미리보기이며 프로덕션 live 전환이나 PR 병합은 실행하지 않았다.

## 2026-10-28 샘플을 도움말로 통합

- 기준: main `43f8a9f`, 작업 브랜치 `one-way/afo-demo-help`, 이슈 #32 후속 사용자 수정 요청.
- 구현: 주요 CTA와 로그인 없이 시작하기는 `/preview`, 고정 샘플은 `/help` 안의 설명용 예시로 통합. `/demo`는 `/help`로 replace 이동. 가상 파일·미리 작성된 결과이며 실제 분류나 개인 규칙을 실행하지 않는다고 명시.
- Unit-verified / 단위 검증: 웹 테스트 7개 통과.
- Simulator-verified / 로컬 브라우저 검증: Firebase Emulator + headless Chromium E2E 21개 통과. 기존 주소 이동, 단일 h1, 샘플 전환·초기화, 모바일 메뉴의 실제 분석 진입과 합성 폴더 분석을 확인. 화면 너비 320/390/1440px 경로 검사, 홈은 320/390/768/1024/1440px 검사.
- 운영 빌드도 localhost:15179에서 `/demo`→도움말→예시 결과→과목별 예시, 로그인 없이 내 폴더 분석하기→`/preview`를 확인. 1440/390px 렌더, 페이지 제목, 가로 넘침, 페이지 오류 없음 확인. Browser plugin not available; regular Playwright를 백그라운드로 사용. 이미지와 임시 검수 스크립트는 `/tmp/afo-help-*.png`, `/tmp/afo-demo-help-qa.mjs`에 저장.
- 명령: website `npm test`, `npm run build`, `npm run build:emulator`, Java PATH를 지정한 `npm run test:e2e`. 운영 빌드에는 기존 500kB 초과 청크 경고가 남음.
- 공개 Hosting 요청: 0회. 실제 공개 사이트에 이 수정 배포, Google 본인 인증, 네이티브 폴더 선택 창 수동 조작, 실물 모바일은 미검증. 이번 로컬 검사를 공개 서비스 검증으로 표현하지 않음.
