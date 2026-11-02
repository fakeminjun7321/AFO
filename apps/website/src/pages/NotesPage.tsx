import { Arrow } from "../components/Icons";
import { notes, remaining, statusRows } from "../data/notes";
import { links } from "../data/project";
import "./site-pages.css";

export function NotesPage() {
  return (
    <section className="notes-page section-wrap">
      <div className="page-heading">
        <h1>개발 노트</h1>
        <p>만든 기능, 실제로 확인한 범위, 남은 일을 GitHub 기록에 맞춰 적습니다. 2026-11-02 기준.</p>
      </div>

      <section className="site-block notes-status" aria-labelledby="notes-status-title">
        <h2 id="notes-status-title">검증 상태</h2>
        <p className="site-note">
          “실제 Mac 검증”은 실제 Mac(macOS 27, Apple Silicon)에서 합성 테스트 파일로 확인했다는 뜻입니다.
          <strong> Windows 실제 PC에서는 아직 확인하지 않았고</strong>, GitHub Actions의 Windows VM에서 자동 테스트만 돌렸습니다.
        </p>
        <div className="site-table site-table--status" role="table" aria-label="기능별 검증 상태">
          <div role="row" className="site-table-head"><span role="columnheader">기능</span><span role="columnheader">macOS</span><span role="columnheader">Windows</span></div>
          {statusRows.map((r) => (
            <div role="row" key={r.feature}>
              <span role="cell">{r.feature}</span>
              <span role="cell" className={r.mac.startsWith("실제") ? "is-verified" : "is-pending"}>{r.mac}</span>
              <span role="cell" className="is-pending">{r.windows}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="site-block" aria-labelledby="notes-log-title">
        <h2 id="notes-log-title">진행 기록</h2>
        <div className="notes-list">
          {notes.map((e) => (
            <article key={e.title}>
              <time>{e.date}</time>
              <div>
                <h3>{e.title}</h3>
                <p>{e.body}</p>
                <div className="note-links">
                  {e.links.map((l) => <a key={l.href} href={l.href} target="_blank" rel="noreferrer">{l.label} <Arrow diagonal /></a>)}
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="site-block next-work" aria-labelledby="notes-next-title">
        <h2 id="notes-next-title">남은 일</h2>
        <ul className="remaining-list">
          {remaining.map((r) => <li key={r.label}><a href={r.href} target="_blank" rel="noreferrer">{r.label} <Arrow diagonal /></a></li>)}
        </ul>
        <p className="site-note">웹사이트는 계속 읽기 전용입니다. 웹에서 파일을 옮기거나 지우는 기능은 없고, 실제 정리는 설치한 CLI에서만 합니다.</p>
      </section>

      <section className="site-block" aria-labelledby="notes-source-title">
        <h2 id="notes-source-title">출처</h2>
        <div className="site-links">
          <a className="quiet-link" href={links.plan} target="_blank" rel="noreferrer">이슈 #1 현재 상태 <Arrow diagonal /></a>
          <a className="quiet-link" href={links.verification} target="_blank" rel="noreferrer">docs/verification 검증 기록 <Arrow diagonal /></a>
          <a className="quiet-link" href={`${links.pulls}?q=is%3Apr+is%3Amerged`} target="_blank" rel="noreferrer">병합된 Pull Request <Arrow diagonal /></a>
        </div>
      </section>
    </section>
  );
}
