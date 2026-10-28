const steps = [
  {
    title: "내 폴더 선택하기",
    body: "내 폴더 분석에서 분석할 폴더를 선택합니다. 로그인이나 설치가 필요하지 않습니다.",
  },
  {
    title: "분류 결과 확인하기",
    body: "확장자와 브라우저에 저장한 활성 규칙으로 제안한 위치를 확인합니다. 파일은 이동하거나 삭제하지 않습니다.",
  },
  {
    title: "내 기준으로 조정하기",
    body: "파일별 제안 폴더를 수정하거나, 나의 규칙에서 분류 기준을 저장한 뒤 다시 적용할 수 있습니다.",
  },
];
export function HowItWorks() {
  return (
    <section
      className="steps section-wrap"
      id="how-it-works"
      aria-label="AFO 사용 방법"
    >
      <ol>
        {steps.map((step, i) => (
          <li key={step.title}>
            <span className="step-number">0{i + 1}</span>
            <div>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
