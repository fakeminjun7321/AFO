const entries = [
  {
    date: "2026.10.27",
    title: "관리자 조회 기능 준비",
    body: "읽기 전용 관리자 API를 구현하고 Emulator에서 검증했습니다. 운영은 무료 Spark를 유지하기로 정해, 공개 관리자 화면에서는 Firebase 콘솔로 사용자·프로젝트·DB·Hosting 정보를 확인합니다.",
  },
  {
    date: "2026.10.26",
    title: "정리 기준을 계정에 보관하기",
    body: "규칙 편집·브라우저 저장·JSON 교환과 클라우드 저장을 연결했습니다. 저장·재조회·계정 분리·버전 충돌을 검증했습니다.",
  },
  {
    date: "2026.10.26",
    title: "로그인과 화면 흐름 정리",
    body: "이메일·Google 로그인 옵션과 관리자 역할을 추가했습니다. 메뉴를 줄이고 로그인·체험·도움말의 정보 위계를 맞췄습니다. 실제 Google 인증 완료와 관리자 진입은 본인 계정 확인이 남아 있습니다.",
  },
  {
    date: "2026.10.26",
    title: "안심하고 확인할 테스트 자료",
    body: "합성 파일과 예시 규칙을 내려받을 수 있게 했습니다. 개인 파일 대신 테스트 자료로 규칙 보관 흐름을 먼저 확인할 수 있습니다.",
  },
];
export function NotesPage() {
  return (
    <section className="notes-page section-wrap">
      <div className="page-heading">
        <h1>개발 노트</h1>
        <p>만든 기능과 확인한 범위를 기록합니다.</p>
      </div>
      <div className="notes-list">
        {entries.map((e) => (
          <article key={e.title}>
            <time>{e.date}</time>
            <div>
              <h2>{e.title}</h2>
              <p>{e.body}</p>
            </div>
          </article>
        ))}
      </div>
      <section className="next-work">
        <h2>다음 단계</h2>
        <p>
          승인·실행·복구 흐름을 순서대로 개발하고 검증합니다.
          현재 웹사이트가 실제 파일을 이동·삭제하는 기능은 제공하지 않습니다.
        </p>
      </section>
    </section>
  );
}
