const steps = [
  {
    title: "폴더 살펴보기",
    body: "로컬 CLI에서 선택한 폴더의 파일 목록을 확인합니다. 정리할 범위는 내가 정해요.",
  },
  {
    title: "나만의 기준 더하기",
    body: "잘 정리해 둔 폴더를 참고해 규칙을 제안받고, 확인한 기준을 적용합니다.",
  },
  {
    title: "미리보기로 확인하기",
    body: "실제 파일을 변경하기 전에, 어떤 폴더로 분류될지 미리 살펴봅니다.",
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
