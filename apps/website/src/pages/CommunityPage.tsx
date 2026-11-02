import { Arrow } from "../components/Icons";
import { links } from "../data/project";
import "./site-pages.css";

const places = [
  { title: "GitHub 저장소", body: "모든 코드와 문서, 검증 기록이 공개돼 있어요.", href: links.repo, cta: "저장소 열기" },
  { title: "Issues", body: "버그 제보와 기능 제안을 받는 곳이에요. 다른 사람이 남긴 이야기도 볼 수 있어요.", href: links.issues, cta: "Issues 보기" },
  { title: "Releases", body: "macOS·Windows용 실행 파일과 SHA256SUMS, 버전별 변경 내용을 받아요.", href: links.releases, cta: "릴리스 보기" },
];

export function CommunityPage() {
  return (
    <section className="site-page section-wrap" aria-labelledby="community-title">
      <div className="page-heading">
        <h1 id="community-title">커뮤니티</h1>
        <p>AFO는 Apache-2.0 오픈소스입니다. 이야기는 GitHub에서 나눠요.</p>
      </div>

      <div className="place-list">
        {places.map((p) => (
          <a key={p.title} href={p.href} target="_blank" rel="noreferrer">
            <span><strong>{p.title}</strong><small>{p.body}</small></span>
            <span className="place-cta">{p.cta} <Arrow diagonal /></span>
          </a>
        ))}
      </div>
      <p className="site-note">지금은 별도 포럼이나 채팅방이 없습니다. 질문·제보·제안은 모두 GitHub Issues로 받아요.</p>

      <section className="site-block" aria-labelledby="community-report">
        <h2 id="community-report">버그를 찾았거나 제안이 있다면</h2>
        <ol className="site-steps">
          <li><strong>먼저 비슷한 이슈가 있는지 찾아보세요.</strong> 있다면 댓글로 상황을 더해 주세요.</li>
          <li><strong>새 이슈를 열어 주세요.</strong> OS와 버전(<code>afo --version</code>), 한 일, 기대한 결과와 실제 결과를 적어 주면 고치기 쉬워요.</li>
          <li><strong>개인 정보는 가려 주세요.</strong> 실제 폴더 경로·파일 이름·파일은 올리지 말고, 테스트 파일이나 새로 만든 폴더로 재현한 내용을 적어 주세요.</li>
        </ol>
        <a className="button button--orange" href={links.newIssue} target="_blank" rel="noreferrer">새 이슈 쓰기 <Arrow diagonal /></a>
      </section>

      <section className="site-block" aria-labelledby="community-code">
        <h2 id="community-code">코드로 참여하기</h2>
        <ol className="site-steps">
          <li><strong>저장소를 fork하고 브랜치를 만드세요.</strong> Node.js 24와 npm이 필요합니다.</li>
          <li><strong>의존성 설치와 테스트</strong> — <code>npm ci --ignore-scripts --no-audit --no-fund</code> 후 <code>npm test</code>. 테스트는 임시로 만든 합성 폴더만 씁니다.</li>
          <li><strong>Pull Request를 열어 주세요.</strong> 무엇을 바꿨는지, 어떻게 확인했는지, 확인하지 못한 것은 무엇인지 적어 주세요. 병합은 메인테이너가 검토 후 합니다.</li>
        </ol>
        <p className="site-note">
          개발 환경과 검사 명령은 <a href={links.development} target="_blank" rel="noreferrer">개발 문서</a>에, 진행 상황은 <a href={links.plan} target="_blank" rel="noreferrer">이슈 #1</a>에 있어요.
          기여한 코드는 <a href={links.license} target="_blank" rel="noreferrer">Apache License 2.0</a>으로 배포됩니다.
        </p>
        <a className="quiet-link" href={links.pulls} target="_blank" rel="noreferrer">열린 Pull Request 보기 <Arrow diagonal /></a>
      </section>
    </section>
  );
}
