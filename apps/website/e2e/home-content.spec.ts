import { test, expect } from "@playwright/test";

test("home explains the available features and links to their actual screens", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /쌓인 파일 정리/ })).toBeVisible();
  await expect(page.getByText("클라우드에만 있는 규칙은 불러온 뒤 브라우저에 저장해 주세요.")).toBeVisible();
  await expect(page.getByText(/승인 후 실행과 복구는 앞으로 개발할 기능/)).toBeVisible();
  await page.getByRole("link", { name: "내 폴더 분석하기" }).click();
  await expect(page).toHaveURL(/\/preview$/);
  await expect(page.getByRole("heading", { name: /폴더를 열고/ })).toBeVisible();
  await page.goto("/");
  await page.getByRole("link", { name: "나의 규칙 살펴보기" }).click();
  await expect(page).toHaveURL(/\/rules$/);
  await expect(page.getByRole("heading", { name: "나의 규칙", exact: true })).toBeVisible();
  await page.goto("/");
  await page.getByRole("link", { name: "사용 방법과 샘플 예시" }).click();
  await expect(page).toHaveURL(/\/help$/);
  await page.getByRole("button", { name: "예시 결과 보기" }).click();
  await expect(page.getByText(/샘플 6개의 예시 결과/)).toBeVisible();
  await page.goto("/guide");
  await expect(page.getByRole("heading", { name: "명령어로 더 자세하게." })).toBeVisible();
  await page.goto("/faq");
  await page.getByText("저장한 규칙이 내 폴더 분석에 적용되나요?").click();
  await expect(page.getByText(/브라우저 보관함에 저장한 활성 규칙이 적용됩니다/)).toBeVisible();
  await page.goto("/status");
  await expect(page.getByRole("heading", { name: "지금 사용할 수 있어요" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "앞으로 만들고 검증할 일" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("home content stays within the viewport at desktop and mobile widths", async ({ page }) => {
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `width ${width}`).toBeTruthy();
    await expect(page.getByRole("link", { name: "내 폴더 분석하기" })).toBeVisible();
  }
});
