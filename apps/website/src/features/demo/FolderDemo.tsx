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
      className="demo-section section-wrap"
      aria-labelledby="demo-title"
    >
      <div className="section-heading">
        <h2 id="demo-title">
          쌓아둔 파일,
          <br />
          정리의 시작.
        </h2>
        <p>
          어떻게 정리되는지 먼저 살펴보세요.
          <br />
          샘플 파일로 체험하며, 실제 파일은 변경하지 않습니다.
        </p>
      </div>
      <div className={`folder-panel${preview ? " is-preview" : ""}`}>
        <div className="folder-toolbar">
          <h3>나의 폴더</h3>
          <div className="folder-actions">
            <span className="sample-count">샘플 6개</span>
            {preview ? (
              <button
                className="button button--small button--outline"
                type="button"
                onClick={reset}
              >
                다시 체험하기
              </button>
            ) : (
              <button
                className="button button--small button--accent"
                type="button"
                onClick={() => setPreview(true)}
              >
                분류 미리보기
              </button>
            )}
          </div>
        </div>
        {preview && (
          <div className="rule-toolbar">
            <label htmlFor="rule">문서 분류 기준</label>
            <select
              id="rule"
              value={personal ? "personal" : "default"}
              onChange={(e) => setPersonal(e.target.value === "personal")}
            >
              <option value="default">기본 분류</option>
              <option value="personal">과목별 정리</option>
            </select>
            <span>기준을 바꾸면 미리보기도 달라져요.</span>
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
            ? "샘플 6개의 분류 위치를 확인했어요. 실제 파일은 변경하지 않았습니다."
            : "파일을 옮기기 전에, 결과부터 확인하세요."}
        </div>
      </div>
    </section>
  );
}
