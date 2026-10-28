import { useState } from "react";
import { Arrow, FileIcon } from "../../components/Icons";
import { sampleFiles } from "./sample";

export function FolderDemo() {
  const [preview, setPreview] = useState(false);
  const [personal, setPersonal] = useState(false);
  function reset() {
    setPreview(false);
    setPersonal(false);
  }
  return (
    <section
      id="demo"
      className="help-sample"
      aria-labelledby="demo-title"
    >
      <div className="section-heading">
        <h2 id="demo-title">샘플 분류 예시</h2>
        <p>
          아래 목록은 설명을 위해 준비한 가상 파일 6개입니다.
          <br />
          버튼과 기준을 바꾸면 미리 작성된 예시 결과를 보여 줍니다. 실제 파일 분석이나 저장한 개인 규칙은 실행하지 않습니다.
        </p>
      </div>
      <div className={`folder-panel${preview ? " is-preview" : ""}`}>
        <div className="folder-toolbar">
          <h3>예시 폴더</h3>
          <div className="folder-actions">
            <span className="sample-count">샘플 6개</span>
            {preview ? (
              <button
                className="button button--small button--outline"
                type="button"
                onClick={reset}
              >
                처음으로
              </button>
            ) : (
              <button
                className="button button--small button--accent"
                type="button"
                onClick={() => setPreview(true)}
              >
                예시 결과 보기
              </button>
            )}
          </div>
        </div>
        {preview && (
          <div className="rule-toolbar">
            <label htmlFor="rule">분류 예시 기준</label>
            <select
              id="rule"
              value={personal ? "personal" : "default"}
              onChange={(e) => setPersonal(e.target.value === "personal")}
            >
              <option value="default">기본 분류</option>
              <option value="personal">과목별 정리 예시</option>
            </select>
            <span>미리 작성된 두 가지 예시를 비교할 수 있어요.</span>
          </div>
        )}
        <div
          className="file-table"
          role="table"
          aria-label={preview ? "샘플 분류 미리보기" : "샘플 파일 목록"}
        >
          <div role="row" className="sr-only">
            <span role="columnheader">파일 이름</span>
            <span role="columnheader">
              {preview ? "분류할 폴더" : "확장자"}
            </span>
            <span role="columnheader">크기</span>
          </div>
          {sampleFiles.map((file) => (
            <div className="file-row" role="row" key={file.name}>
              <div role="cell" className="file-name">
                <FileIcon kind={file.kind} />
                <span>{file.name}</span>
              </div>
              <div
                role="cell"
                className={preview ? "file-destination" : "file-extension"}
              >
                {preview ? (
                  <>
                    <Arrow />
                    <span>
                      {personal && file.personalDestination
                        ? file.personalDestination
                        : file.destination}
                    </span>
                  </>
                ) : (
                  file.extension
                )}
              </div>
              <span role="cell" className="file-size">
                {file.size}
              </span>
            </div>
          ))}
        </div>
        <div className="panel-footer" role="status" aria-live="polite">
          {preview
            ? "샘플 6개의 예시 결과입니다. 실제 분석 결과는 내 폴더 분석에서 확인하세요."
            : "이 목록은 가상 파일로 구성된 설명용 예시입니다."}
        </div>
      </div>
    </section>
  );
}
