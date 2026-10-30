import { Link } from "react-router-dom";
import "./status.css";

export function StatusPage() {
  return <section className="status-page section-wrap" aria-labelledby="status-title">
    <div className="status-heading"><p>DEVELOPMENT STATUS</p><h1 id="status-title">지금 할 수 있는 일과<br />앞으로 만들 일.</h1><p>이 버전의 제공 범위를 안내합니다. 파일 정리는 항상 결과를 먼저 확인할 수 있도록 개발하고 있습니다.</p></div>
    <div className="status-sections">
      <section aria-labelledby="status-now"><div className="status-section-header"><h2 id="status-now">지금 사용할 수 있어요</h2><span>웹은 읽기 전용</span></div><div className="status-rows">
        <article><h3>웹 폴더 미리보기</h3><p>선택한 폴더의 분류와 제안 위치를 확인하고, 브라우저에 저장된 개인 규칙을 적용하고 파일별 제안을 수정하거나 폴더 구조로 볼 수 있습니다. 숨김 파일과 빈 폴더 등은 확인 범위에서 제외됩니다.</p><Link to="/preview">내 폴더 분석하기 →</Link></article>
        <article><h3>중복 후보 검사</h3><p>직접 검사할 때만 같은 크기인 파일의 내용을 이 기기에서 비교합니다. 파일 크기·전체 검사량 한도와 읽기 실패를 결과에 표시합니다.</p><Link to="/preview">검사 화면으로 →</Link></article>
        <article><h3>나의 규칙 보관</h3><p>확장자와 파일 이름으로 규칙을 만들고 저장 전 선택한 목록에 시험할 수 있습니다. 브라우저 또는 JSON으로 보관하며 클라우드 저장은 로그인과 서비스 연결이 필요합니다.</p><Link to="/rules">규칙 만들기 →</Link></article>
        <article><h3>로컬 CLI 정리 실행</h3><p>별도 Node.js 환경에서 폴더 분석, 내용 해시 중복 후보, 참고 폴더 기반 개인 규칙을 확인한 뒤 정리 계획을 만듭니다. 승인 코드를 직접 입력한 항목만 실제로 옮기거나 OS 휴지통으로 보내며, 옮긴 파일은 되돌릴 수 있습니다. 영구 삭제는 따로 선택하고 확인 문구를 입력해야 하며 되돌릴 수 없습니다. macOS에서 확인했고 Windows 실기기 확인은 남아 있습니다.</p><Link to="/guide">사용 방법 →</Link></article>
        <article><h3>분석 범위와 결과 저장</h3><p>하위 폴더와 확장자를 제외하고 현재 범위의 결과를 JSON 또는 CSV로 내보낼 수 있습니다. 내보낸 파일에 이름과 상대 경로가 포함됩니다.</p><Link to="/preview">결과 살펴보기 →</Link></article>
      </div></section>
      <section aria-labelledby="status-next"><div className="status-section-header"><h2 id="status-next">앞으로 만들고 검증할 일</h2><span>미제공</span></div><div className="status-rows">
        <article><h3>웹에서 바로 정리하기</h3><p>승인한 이동·되돌리기는 지금 로컬 CLI에서만 제공합니다. 웹에서는 파일을 옮기지 않으며, 웹 화면과 CLI 실행을 잇는 방법은 아직 정하지 않았습니다.</p></article>
        <article><h3>중단 복구와 Windows 실기기 확인</h3><p>실행 중 강제 종료와 여러 실행이 겹치는 경우의 복구, Windows 실제 기기의 이동·휴지통·영구 삭제 경로를 더 확인해야 합니다. 웹에서는 삭제하거나 휴지통으로 보내지 않습니다.</p></article>
        <article><h3>브라우저·기기 검증 확대</h3><p>폴더 선택, 대용량 파일과 다양한 OS·브라우저의 실제 사용 경로를 추가로 확인해야 합니다.</p></article>
      </div></section>
    </div>
    <p className="status-end">선택 목록은 빈 폴더와 일부 제외 항목을 담지 못할 수 있으므로 충돌 표시가 모든 충돌을 보장하지 않습니다.</p>
  </section>;
}
