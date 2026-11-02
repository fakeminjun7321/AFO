const steps = [
  {
    title: "afo 입력하고 폴더 끌어다 놓기",
    body: "설치한 뒤 터미널(Windows는 PowerShell)에 afo를 입력하고, 정리할 폴더를 창으로 끌어다 놓은 뒤 Enter를 누릅니다.",
  },
  {
    title: "요약 확인하기",
    body: "분류별 파일 수, 확인이 필요한 파일, 그대로 둘 파일과 이유, 같은 내용의 사본을 보여 줍니다. 아직 파일은 그대로예요.",
  },
  {
    title: "정리 방법 고르기",
    body: "1) 폴더별로 정리하기 2) 중복 파일을 휴지통으로 보내기 3) 자세히 보기 4) 그만두기 중 번호를 입력합니다.",
  },
  {
    title: "확인 코드 입력하기",
    body: "화면에 나온 코드를 직접 입력해야 실행합니다. 폴더 정리는 afo undo로 되돌리고, 휴지통으로 보낸 파일은 OS 휴지통에서 꺼낼 수 있어요.",
  },
];
export function HowItWorks() {
  return (
    <section
      className="steps section-wrap"
      id="how-it-works"
      aria-label="afo 사용 단계"
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
