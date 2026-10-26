# AFO 웹사이트

[이슈 #32](https://github.com/fakeminjun7321/AFO/issues/32). 사용자 요청에 따라 [SWSH](https://www.joinswsh.com/)를 디자인 참고로 제작한 한국어 제품 소개·샘플 체험 웹사이트입니다. React + Vite 독립 패키지이며 루트 CLI와 Firebase 연동 패키지의 설정·lockfile을 바꾸지 않습니다.

## 제공하는 동작

- 제품 소개, 사용 방법, FAQ, 모바일 메뉴와 섹션 이동
- 합성 샘플 6개의 분류 전후 비교
- 기본 분류와 과목별 정리의 미리 정한 샘플 결과 전환, 초기화
- 자체 호스팅 한글 폰트와 이미지, 외부 API·파일 업로드·분석 스크립트 없음

**이 화면은 샘플 체험입니다.** 실제 사용자 파일을 읽거나 이동·삭제하지 않습니다. 새로고침 시 샘플 상태가 초기화됩니다. 공용 파일 분류 엔진을 복제하지 않으며, `sample.ts`의 설명용 결과만 보여 줍니다. 로그인·Firestore·로컬 CLI 연결은 포함하지 않습니다. Firebase 연동 기반은 별도 #25에서 개발합니다.

## 로컬 실행

Node.js 24, npm을 사용합니다. 아래 명령은 이 디렉터리에서 실행합니다.

```sh
npm ci
npm run dev
```

개발 서버: http://127.0.0.1:15173

```sh
npm run build
npm run preview
```

Vite 빌드 미리보기: http://127.0.0.1:15174

## Firebase Hosting

[공식 Hosting 설정](https://firebase.google.com/docs/hosting/full-config)에 따라 `firebase.json`의 `public`을 빌드 결과 `dist`로 지정했습니다. 보안 헤더와 CSP는 현재 정적 사이트의 자기 출처 리소스만 허용합니다. 향후 Firebase Auth/Firestore를 연결할 때 허용 출처를 필요한 범위로 추가하고 실제 요청을 다시 검증해야 합니다.

Firebase CLI가 설치된 환경에서 빌드 후 다음 명령으로 **클라우드에 연결하지 않는 demo 프로젝트**를 사용합니다.

```sh
npm run build
firebase emulators:start --only hosting --project demo-afo-website --config firebase.json --non-interactive
```

검증 URL: http://127.0.0.1:15175

실제 연결 대상으로 `afo-hackathon-2026-7321` / Hosting site `afo-hackathon-2026-7321`이 존재함을 읽기 전용으로 확인했습니다. 공개 배포는 이번 변경에서 실행하지 않았습니다. 프로젝트 지침이 별도 허가를 요구하므로, 승인 시 새 `website-design` preview 채널에 배포하고 기존 `setup` 채널·live 사이트·Auth·Firestore 설정은 변경하지 않는 안입니다. 외부 공개 미리보기에는 디자인 이미지와 샘플 데이터만 포함됩니다.

## 디자인·검증

- [디자인 기준과 생성 브리프](design/DESIGN.md), 콘셉트 이미지 3개
- [검증 수준·비교 기록](verification/VERIFICATION.md), 브라우저 결과 JSON과 최종 렌더 이미지
- 빌드·타입 검사와 UI 검증은 실제 로컬 파일 정리·클라우드 인증·사용자별 저장을 증명하지 않습니다.

폰트: Pretendard 1.3.9, OFL-1.1. `public/assets/Pretendard-LICENSE.txt`를 동봉했습니다. 히어로 오브젝트는 이 작업에서 built-in Image Gen으로 생성했습니다. 참조 사이트의 사진·로고·고객 지표를 복제하지 않았습니다.
