import { test, expect } from "@playwright/test";

test("home explains the available features and links to their actual screens", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /쌓인 파일 정리/ })).toBeVisible();
  await expect(page.getByText("웹 규칙은 현재 웹 폴더 미리보기에 자동 적용되지 않습니다.")).toBeVisible();
  await expect(page.getByText(/승인 후 실행과 복구는 앞으로 개발할 기능/)).toBeVisible();
  await page.getByRole("link", { name: "내 폴더 분석하기" }).click();
  await expect(page).toHaveURL(/\/preview$/);
  await expect(page.getByRole("heading", { name: /폴더를 열고/ })).toBeVisible();
  await page.goto("/");
  await page.getByRole("link", { name: "나의 규칙 살펴보기" }).click();
  await expect(page).toHaveURL(/\/rules$/);
  await expect(page.getByRole("heading", { name: "나의 정리 기준." })).toBeVisible();
  await page.goto("/");
  await page.getByRole("link", { name: "샘플로 체험하기" }).click();
  await expect(page).toHaveURL(/\/demo$/);
  await page.getByRole("button", { name: "분류 미리보기" }).click();
  await expect(page.getByText(/샘플 6개의 분류 위치/)).toBeVisible();
  await page.goto("/guide");
  await expect(page.getByRole("heading", { name: "명령어로 더 자세하게." })).toBeVisible();
  await page.goto("/faq");
  await page.getByText("저장한 규칙이 내 폴더 분석에 적용되나요?").click();
  await expect(page.getByText(/아직은 적용되지 않습니다/)).toBeVisible();
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
