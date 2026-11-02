import { Link } from "react-router-dom";
import pack from "../data/test-pack.json";
import { Arrow } from "../components/Icons";
export function DownloadsPage() {
  return (
    <section className="downloads-page section-wrap">
      <div className="page-heading">
        <h1>테스트 파일</h1>
        <p>개인 파일을 넣기 전에, 준비된 합성 자료로 웹 미리보기와 afo를 확인하세요.</p>
      </div>
      <div className="download-main">
        <div>
          <h2>AFO 체험 파일 모음</h2>
          <p>
            문서·이미지·CSV·소리·압축 파일 {pack.sampleFileCount}개와 예시 규칙,
            사용 방법이 들어 있습니다. 실행 프로그램이나 개인정보는 없습니다.
          </p>
          <span className="download-meta">
            ZIP · {(pack.bytes / 1024).toFixed(1)} KB · {pack.date}
          </span>
        </div>
        <a
          className="button button--orange"
          href="/downloads/AFO-test-files.zip"
          download
        >
          테스트 ZIP 받기 <Arrow />
        </a>
      </div>
      <div className="download-guide">
        <h2>이렇게 사용하세요.</h2>
        <ol>
          <li>새 폴더에 ZIP을 풀어주세요.</li>
          <li>
            <Link to="/rules">나의 규칙</Link>의 JSON 도구에서{" "}
            <code>예시_규칙.json</code>을 가져오세요.
          </li>
          <li>
            브라우저에 저장하고 새로고침해 같은 규칙이 남는지 확인하세요. 로그인
            후에는 클라우드 보관도 확인할 수 있어요.
          </li>
          <li>
            <Link to="/preview">내 폴더 분석</Link>에서 압축을 푼 폴더 안의{" "}
            <code>정리할파일</code> 폴더를 선택해 분류와 중복 후보를 확인하세요.
          </li>
          <li>
            <Link to="/install">AFO를 설치</Link>했다면 터미널에 <code>afo</code>를 입력하고 같은 <code>정리할파일</code> 폴더를
            끌어다 놓아 실제 정리와 <code>afo undo</code>를 시험해 보세요. 개인 파일 대신 이 합성 자료로 먼저 확인하는 걸 권해요.
          </li>
        </ol>
        <p>
          도움말의 샘플 분류 예시는 미리 작성된 결과입니다. 내 폴더 분석에서는 사용자가
          직접 선택한 폴더를 읽기 전용으로 살펴봅니다. 파일을 이동하거나 삭제하지
          않으며, 중복 검사 시에는 파일 내용을 이 기기에서 읽습니다.
        </p>
        <a
          className="quiet-link"
          href="/downloads/AFO-example-rules.json"
          download
        >
          예시 규칙 JSON만 받기 <Arrow />
        </a>
      </div>
      <details className="download-integrity">
        <summary>포함 파일과 검증 정보</summary>
        <ul>
          {pack.files.map((f) => (
            <li key={f.name}>
              {f.name} <span>{f.bytes.toLocaleString()} bytes</span>
            </li>
          ))}
        </ul>
        <p>물리 실험 문서와 복사본은 내용이 같은 중복 후보입니다.</p>
        <p className="hash-line">
          ZIP SHA-256 <code>{pack.sha256}</code>
        </p>
      </details>
    </section>
  );
}
