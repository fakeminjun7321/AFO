# AFO 웹사이트 자동 배포 준비

## 현재 상태

이 변경은 **비활성 상태의 준비**다. GitHub Actions 변수 `AFO_HOSTING_AUTODEPLOY`가 정확히 `enabled`이고 전용 자격 증명이 등록되기 전에는 배포 단계가 실행되지 않는다. 이 문서는 배포 완료나 실제 서비스 검증을 뜻하지 않는다.

대상 저장소는 비공개 `fakeminjun7321/AFO`, Firebase 프로젝트·Hosting 사이트는 `afo-hackathon-2026-7321`, 채널은 `live`, 공개 주소는 `https://afo-hackathon-2026-7321.web.app`이다. 2026-10-28 확인 시 결제 계정은 연결되지 않았고, live 채널에는 release가 없었으며 해당 주소는 HTTP 404였다. 별도의 `website-design` 및 `setup` 미리보기 채널은 이 파이프라인의 배포 대상이 아니다.

## 동작과 제한

- 웹사이트·Firebase 클라이언트·공용 엔진·워크플로에 영향을 주는 `main` push에서만 기존 빌드·단위 검사·에뮬레이터 브라우저 검사를 실행하고, 모두 통과한 뒤 Hosting만 배포한다. PR과 수동 워크플로 실행에는 배포하지 않는다.
- 검증을 마친 커밋보다 새로운 관련 변경이 `main`에 있으면 이전 배포를 건너뛴다. 관련 없는 문서만 바뀐 경우에는 검증한 웹 결과를 배포할 수 있다. 연속된 관련 push는 기존 `website-refs/heads/main` 동시성 그룹으로 이전 실행을 취소한다.
- 사이트 ID, 빌드 출력 위치, 정적 Hosting 구성, 공개 관리자 API 비활성 상태를 검사한다. Firebase의 Firestore 규칙·Auth 설정·Functions·IAM은 배포하지 않는다. 파일 트리의 링크나 특수 파일은 거부한다.
- 배포용 자격 증명은 현재 제안상 GitHub 저장소 Secret `AFO_FIREBASE_HOSTING_DEPLOY`로 전달하며, 배포 단계에서만 일시 파일로 쓰고 종료 시 제거한다. 비밀값은 출력하거나 저장소에 커밋하지 않는다.
- GitHub 저장소에 쓰기 권한이 있는 사람은 워크플로를 수정해 저장소 Secret에 접근할 수 있다. 현재 이 비공개 저장소에는 소유자 외에도 쓰기 권한이 있는 협업자가 있으며, 이 점은 활성화 전에 고려해야 한다. 서비스 계정 키는 장기 자격 증명이므로 유출 의심 시 즉시 비활성화·교체해야 한다.

## 활성화 전에 확인할 대상

- 새 서비스 계정 후보: `afo-hosting-cd@afo-hackathon-2026-7321.iam.gserviceaccount.com`.
- 사용자 정의 역할 후보: 프로젝트 정보 조회와 `firebasehosting.sites.get`, `firebasehosting.sites.list`, `firebasehosting.sites.update`만 부여한다. 사이트 삭제·Auth·Firestore·Functions·결제 권한은 포함하지 않는다. 실제 Firebase CLI가 이 최소 권한으로 동작하는지는 아직 확인하지 않았다.
- 이 역할은 프로젝트 범위이므로 `sites.update` 권한이 같은 프로젝트의 다른 Hosting 채널에도 미칠 수 있다. 스크립트는 기본 사이트와 `live`만 지정하지만 IAM 자체가 채널 단위로 제한되는 것은 아니다.
- 공식 Google Cloud 배포 파이프라인 문서는 Workload Identity Federation 준비 조건으로 결제 활성화 확인을 요구한다. 현재 프로젝트는 결제가 비활성화되어 있으므로 요금제를 바꾸지 않고 검토 가능한 Firebase 공식 GitHub 연동의 서비스 계정 키 방식을 준비했다. 키 없는 방식이 이 프로젝트에서 가능한지는 미검증이다.
- Spark를 유지할 경우 Hosting은 무료 한도에 도달하면 새 배포가 막히거나 전송량 한도 초과 후 사이트가 비활성화될 수 있다. 결제 계정 연결·Blaze 전환은 수행하지 않는다.

## 검증과 중단

현재까지는 가짜 자격 증명·임시 Git 저장소로 잘못된 이벤트, 브랜치, 저장소, 계정, 오래된 커밋, 잘못된 Hosting 대상, 관리자 API 활성화 및 출력 디렉터리 링크를 거부하는 검사만 수행한다. 실제 서비스 계정·GitHub Secret·배포는 아직 생성하거나 검증하지 않았다.

활성화된 이후 긴급 중단이 필요하면 GitHub 저장소 변수 `AFO_HOSTING_AUTODEPLOY`를 `disabled`로 바꾼다. 이미 완료된 배포를 되돌리지는 않으므로 Hosting release 상태를 별도로 확인해야 한다. 첫 live 배포 전에는 현재 비어 있는 live 상태를 보존하고, 이후 복구 방법은 실제 release를 확인한 뒤 적용한다.

참고: [Firebase Hosting GitHub 연동](https://firebase.google.com/docs/hosting/github-integration), [Firebase Hosting 사용량과 한도](https://firebase.google.com/docs/hosting/usage-quotas-pricing), [Google Cloud 배포 파이프라인 인증](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines), [GitHub 환경 보호 가용성](https://docs.github.com/en/rest/deployments/environments).
