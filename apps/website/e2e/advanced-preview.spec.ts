import { test, expect } from "@playwright/test";
import { mkdtemp, mkdir, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function addRule(page: import("@playwright/test").Page) {
  await page.goto("/rules");
  await page.getByRole("button", { name: /규칙 추가/ }).click();
  await page.getByLabel("규칙 1 키워드").fill("물리");
  await page.getByLabel("규칙 1 폴더").fill("학교/물리");
  await page.getByRole("button", { name: "브라우저에 저장" }).click();
  await expect(page.getByRole("status")).toContainText("이 브라우저에 저장했어요");
}
async function chooseFolder(page: import("@playwright/test").Page, root: string) {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "폴더 선택하기" }).click();
  await (await chooser).setFiles(root);
}

test("saved rules, collisions, search and opt-in duplicate checks use synthetic local files", async ({ page }) => {
  const root = await mkdtemp(join(tmpdir(), "afo-preview-advanced-"));
  try {
    for (const directory of ["docs", "copies", "a", "b", "문서"]) await mkdir(join(root, directory));
    const contents = "synthetic-unique-sentinel-589";
    await writeFile(join(root, "docs", "물리_보고서.pdf"), contents);
    await writeFile(join(root, "copies", "복제.pdf"), contents);
    await writeFile(join(root, "a", "동일.pdf"), "value1");
    await writeFile(join(root, "b", "동일.pdf"), "value2");
    await writeFile(join(root, "기존.pdf"), "x1");
    await writeFile(join(root, "문서", "기존.pdf"), "x2");
    await writeFile(join(root, "mystery.xyz"), "unknown");
    await writeFile(join(root, ".hidden"), "hidden");
    await page.addInitScript(() => {
      const original = File.prototype.arrayBuffer;
      (window as unknown as { afoReads: number }).afoReads = 0;
      File.prototype.arrayBuffer = function () { (window as unknown as { afoReads: number }).afoReads++; return original.call(this); };
    });
    await addRule(page);
    await page.goto("/preview");
    const requests: { url: string; body: string }[] = [];
    page.on("request", (request) => requests.push({ url: request.url(), body: request.postData() ?? "" }));
    await chooseFolder(page, root);
    await expect(page.getByText("학교/물리/물리_보고서.pdf")).toBeVisible();
    await expect(page.getByText("저장한 개인 규칙을 적용했어요")).toBeVisible();
    await expect(page.getByText(/다른 파일과 제안 위치가 같아요/)).toHaveCount(2);
    await expect(page.getByText(/선택된 목록의 파일 또는 폴더와 위치가 겹쳐요/)).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { afoReads: number }).afoReads)).toBe(0);
    await page.getByLabel("파일이나 제안 위치 검색").fill("복제");
    await expect(page.getByText("copies/복제.pdf")).toBeVisible();
    await expect(page.getByText("docs/물리_보고서.pdf")).toHaveCount(0);
    await page.getByLabel("파일이나 제안 위치 검색").clear();
    await page.getByRole("button", { name: "중복 검사 시작" }).click();
    await expect(page.getByRole("status").filter({ hasText: "동일한 해시의 후보 1그룹" })).toBeVisible();
    const group = page.locator(".local-duplicate-group");
    await expect(group).toContainText("docs/물리_보고서.pdf");
    await expect(group).toContainText("copies/복제.pdf");
    expect(await page.evaluate(() => (window as unknown as { afoReads: number }).afoReads)).toBeGreaterThan(0);
    expect(requests.some((request) => `${request.url} ${request.body}`.includes(contents))).toBeFalsy();
    expect(await readFile(join(root, "docs", "물리_보고서.pdf"), "utf8")).toBe(contents);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("pagination and search reach files beyond the first page", async ({ page }) => {
  const root = await mkdtemp(join(tmpdir(), "afo-preview-pages-"));
  try {
    for (let i = 0; i < 105; i++) await writeFile(join(root, `file-${String(i).padStart(3, "0")}.txt`), `content ${i}`);
    await page.goto("/preview"); await chooseFolder(page, root);
    await expect(page.getByText("1 / 2 페이지 · 105개")).toBeVisible();
    await page.getByRole("button", { name: "다음" }).click();
    await expect(page.getByText("2 / 2 페이지 · 105개")).toBeVisible();
    await page.getByLabel("파일이나 제안 위치 검색").fill("file-104");
    await expect(page.getByText("file-104.txt", { exact: true })).toBeVisible();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("oversized candidates are explicitly reported as not examined", async ({ page }) => {
  const root = await mkdtemp(join(tmpdir(), "afo-preview-limit-"));
  try {
    for (const name of ["large-a.bin", "large-b.bin"]) { const path = join(root, name); await writeFile(path, ""); await truncate(path, 64 * 1024 * 1024 + 1); }
    await page.goto("/preview"); await chooseFolder(page, root);
    await page.getByRole("button", { name: "중복 검사 시작" }).click();
    await expect(page.getByText(/검사 0개 · 한도 제외 2개/)).toBeVisible();
    await expect(page.getByText(/전체 폴더에 중복이 없다고 판단할 수 없습니다/)).toBeVisible();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("guest rules are not applied after another tab signs in", async ({ page, context }) => {
  const root = await mkdtemp(join(tmpdir(), "afo-preview-account-"));
  try {
    await writeFile(join(root, "물리.pdf"), "synthetic");
    await addRule(page);
    await page.goto("/preview"); await chooseFolder(page, root);
    await expect(page.getByText("학교/물리/물리.pdf")).toBeVisible();
    const account = await context.newPage();
    await account.goto("/signup");
    await account.getByLabel("이메일", { exact: true }).fill(`preview-${Date.now()}@example.invalid`);
    await account.getByLabel("비밀번호", { exact: true }).fill("Synthetic-Only-274!");
    await account.getByLabel("비밀번호 확인").fill("Synthetic-Only-274!");
    await account.getByRole("button", { name: "계정 만들기" }).click();
    await expect(account).toHaveURL(/\/account$/);
    await expect(page.getByText(/로그인 계정의 브라우저 보관함 · 사용 중인 개인 규칙 0개/)).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("문서/물리.pdf")).toBeVisible();
    await account.getByRole("button", { name: "로그아웃", exact: true }).click();
    await expect(page.getByText("학교/물리/물리.pdf")).toBeVisible({ timeout: 15000 });
    await account.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("conflicting rules require review and another tab's saved change is applied", async ({ page, context }) => {
  const root = await mkdtemp(join(tmpdir(), "afo-preview-conflict-"));
  try {
    await writeFile(join(root, "물리.pdf"), "synthetic");
    await addRule(page);
    await page.getByRole("button", { name: /규칙 추가/ }).click();
    await page.getByLabel("규칙 2 키워드").fill("물리");
    await page.getByLabel("규칙 2 폴더").fill("다른/경로");
    await page.getByRole("button", { name: "브라우저에 저장" }).click();
    await page.goto("/preview"); await chooseFolder(page, root);
    await expect(page.getByText("개인 규칙의 목적지가 서로 달라요")).toBeVisible();
    const editor = await context.newPage(); await editor.goto("/rules");
    await editor.getByLabel("규칙 2 폴더").waitFor();
    await editor.locator(".rule-edit").nth(1).getByRole("checkbox", { name: "사용" }).uncheck();
    await editor.getByRole("button", { name: "브라우저에 저장" }).click();
    await expect(page.getByText("학교/물리/물리.pdf")).toBeVisible();
    await editor.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unreadable stored rules are preserved and default classification is clearly reported", async ({ page }) => {
  const root = await mkdtemp(join(tmpdir(), "afo-preview-corrupt-"));
  try {
    await writeFile(join(root, "물리.pdf"), "synthetic");
    await page.addInitScript(() => localStorage.setItem("afo.rules.v1:guest", "{corrupt"));
    await page.goto("/preview"); await chooseFolder(page, root);
    await expect(page.getByText(/저장된 규칙을 읽지 못했어요/)).toBeVisible();
    await expect(page.getByText("문서/물리.pdf")).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("afo.rules.v1:guest"))).toBe("{corrupt");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("switching folders cancels an in-flight scan without displaying old results", async ({ page }) => {
  const first = await mkdtemp(join(tmpdir(), "afo-preview-first-"));
  const second = await mkdtemp(join(tmpdir(), "afo-preview-second-"));
  try {
    await writeFile(join(first, "old-a.txt"), "same");
    await writeFile(join(first, "old-b.txt"), "same");
    await writeFile(join(second, "new.txt"), "new");
    await page.addInitScript(() => {
      const original = File.prototype.arrayBuffer;
      File.prototype.arrayBuffer = async function () { await new Promise((resolve) => setTimeout(resolve, 600)); return original.call(this); };
    });
    await page.goto("/preview"); await chooseFolder(page, first);
    await page.getByRole("button", { name: "중복 검사 시작" }).click();
    await expect(page.getByRole("button", { name: "검사 취소" })).toBeVisible();
    await expect(page.getByRole("button", { name: "중복 검사 시작" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "검사 취소" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("alert")).toContainText("중복 검사를 취소했습니다.");
    await page.getByRole("button", { name: "중복 검사 시작" }).click();
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "다른 폴더 선택" }).click();
    await (await chooser).setFiles(second);
    await expect(page.getByText("new.txt", { exact: true })).toBeVisible();
    await page.waitForTimeout(900);
    await expect(page.getByText(/동일한 해시의 후보/)).toHaveCount(0);
    await page.getByRole("button", { name: "중복 검사 시작" }).click();
    await expect(page.getByText(/검사한 파일에서 일치하는 후보를 찾지 못했어요/)).toBeVisible();
  } finally { await rm(first, { recursive: true, force: true }); await rm(second, { recursive: true, force: true }); }
});

test("an unreadable candidate is counted and prevents a complete result", async ({ page }) => {
  const root = await mkdtemp(join(tmpdir(), "afo-preview-unreadable-"));
  try {
    await writeFile(join(root, "good.txt"), "same");
    await writeFile(join(root, "bad.txt"), "same");
    await page.addInitScript(() => {
      const original = File.prototype.arrayBuffer;
      File.prototype.arrayBuffer = function () { return this.name === "bad.txt" ? Promise.reject(new DOMException("test read failure", "NotReadableError")) : original.call(this); };
    });
    await page.goto("/preview"); await chooseFolder(page, root);
    await page.getByRole("button", { name: "중복 검사 시작" }).click();
    await expect(page.getByText(/읽기 실패 1개/)).toBeVisible();
    await expect(page.getByText(/전체 폴더에 중복이 없다고 판단할 수 없습니다/)).toBeVisible();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the file count cap reports a partial result", async ({ page }) => {
  await page.goto("/preview");
  await page.locator("input[aria-label='분석할 폴더']").evaluate((element) => {
    const transfer = new DataTransfer();
    for (let i = 0; i < 5001; i++) {
      const file = new File(["x"], `item-${i}.txt`);
      Object.defineProperty(file, "webkitRelativePath", { value: `synthetic/item-${i}.txt` });
      transfer.items.add(file);
    }
    const input = element as HTMLInputElement;
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(page.getByText(/처음 5,000개만 분석했어요. 전체 결과가 아닙니다/)).toBeVisible();
  await expect(page.getByRole("button", { name: "전체 5000" })).toBeVisible();
});
