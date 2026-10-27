import { test, expect } from "@playwright/test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function choose(page: import("@playwright/test").Page, folder: string) {
  await page.goto("/preview");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "폴더 선택하기" }).click();
  await (await chooser).setFiles(folder);
}

test("per-file overrides recompute conflicts and the tree shows current and proposed structures", async ({ page }) => {
  const root = await mkdtemp(join(tmpdir(), "afo-adjust-"));
  try {
    await mkdir(join(root, "a")); await mkdir(join(root, "b"));
    await writeFile(join(root, "a", "같은.pdf"), "a"); await writeFile(join(root, "b", "같은.pdf"), "b");
    await choose(page, root);
    await expect(page.getByText("다른 파일과 제안 위치가 같아요")).toHaveCount(2);
    const a = page.locator(".local-row").filter({ hasText: "a/같은.pdf" });
    await a.getByText("위치 변경").click();
    await a.getByLabel("a/같은.pdf 제안 폴더").fill("../outside");
    await a.getByRole("button", { name: "위치 적용" }).click();
    await expect(a.getByRole("alert")).toContainText("상대 경로");
    await a.getByLabel("a/같은.pdf 제안 폴더").fill("학교/물리");
    await a.getByRole("button", { name: "위치 적용" }).click();
    await expect(a.getByText("학교/물리/같은.pdf")).toBeVisible();
    await expect(page.getByText("다른 파일과 제안 위치가 같아요")).toHaveCount(0);
    const b = page.locator(".local-row").filter({ hasText: "b/같은.pdf" });
    await b.getByText("위치 변경").click(); await b.getByRole("button", { name: "그대로 두기" }).click();
    await expect(b.getByText(/그대로 두기로 선택/)).toBeVisible();
    await page.getByRole("button", { name: "폴더 구조로 보기" }).click();
    const current = page.locator(".tree-columns > div").nth(0);
    const proposed = page.locator(".tree-columns > div").nth(1);
    await expect(current.getByText("a/", { exact: true })).toBeVisible();
    await expect(current.getByText("b/", { exact: true })).toBeVisible();
    await proposed.getByText("학교/", { exact: true }).click();
    await proposed.getByText("물리/", { exact: true }).click();
    await expect(proposed.getByText("같은.pdf", { exact: true })).toBeVisible();
    await proposed.getByText("b/", { exact: true }).click();
    await expect(proposed.getByText("같은.pdf", { exact: true })).toHaveCount(2);
    await page.getByRole("link", { name: "규칙 편집" }).click();
    await page.locator(".rule-trial").getByRole("link", { name: "선택한 폴더 미리보기로 돌아가기" }).click();
    await expect(page.getByText("학교/물리/같은.pdf")).toBeVisible();
    await expect(page.getByText(/그대로 두기로 선택/)).toBeVisible();
    await page.reload();
    await expect(page.getByRole("button", { name: "폴더 선택하기" })).toBeVisible();
    await expect(page.getByText("학교/물리/같은.pdf")).toHaveCount(0);
    expect(await readFile(join(root, "a", "같은.pdf"), "utf8")).toBe("a");
    expect(await readFile(join(root, "b", "같은.pdf"), "utf8")).toBe("b");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("scope exclusions preserve collision detection and limit duplicate checks and exports", async ({ page }) => {
  const root = await mkdtemp(join(tmpdir(), "afo-scope-"));
  try {
    await mkdir(join(root, "문서")); await mkdir(join(root, "원본"));
    await writeFile(join(root, "문서", "보고서.pdf"), "same");
    await writeFile(join(root, "원본", "보고서.pdf"), "same");
    await writeFile(join(root, "photo.jpg"), "photo");
    await choose(page, root);
    await page.getByText("분석 범위 바꾸기").click();
    await page.getByLabel("하위 폴더").selectOption("문서");
    await page.getByRole("button", { name: "폴더 제외", exact: true }).click();
    await page.getByLabel("파일 종류").selectOption(".jpg");
    await page.getByRole("button", { name: "종류 제외", exact: true }).click();
    await expect(page.getByText("파일 1개 분석 · 2개 제외")).toBeVisible();
    await expect(page.getByText("원본/보고서.pdf", { exact: true })).toBeVisible();
    await expect(page.getByText(/선택된 목록의 파일 또는 폴더와 위치가 겹쳐요/)).toBeVisible();
    await page.getByRole("button", { name: "중복 검사 시작" }).click();
    await expect(page.getByText(/검사 0개 · 한도 제외 0개/)).toBeVisible();
    const wait = page.waitForEvent("download"); await page.getByRole("button", { name: "JSON 저장" }).click();
    const json = JSON.parse(await readFile((await (await wait).path())!, "utf8"));
    expect(json.excluded).toBe(2); expect(json.items.map((x: {path: string}) => x.path)).toEqual(["원본/보고서.pdf"]);
    expect(json.scope.directories).toEqual(["문서"]); expect(json.scope.extensions).toEqual([".jpg"]);
    await page.getByRole("button", { name: "종류 .jpg 제외 해제 ×" }).click();
    await expect(page.getByText("파일 2개 분석 · 1개 제외")).toBeVisible();
    await expect(page.getByText(/검사 0개 · 한도 제외 0개/)).toHaveCount(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("draft rules can be tested against selected files without saving", async ({ page }) => {
  const root = await mkdtemp(join(tmpdir(), "afo-trial-"));
  try {
    await writeFile(join(root, "물리.pdf"), "synthetic"); await writeFile(join(root, "역사.pdf"), "other");
    await choose(page, root);
    await page.getByRole("link", { name: "규칙 편집" }).click();
    await page.getByRole("button", { name: /규칙 추가/ }).click();
    await page.getByLabel("규칙 1 키워드").fill("물리");
    await page.getByLabel("규칙 1 폴더").fill("학교/물리");
    const trial = page.locator(".rule-trial");
    await expect(trial.getByText(/활성 규칙에 맞는 파일 1개/)).toBeVisible();
    await expect(trial.getByText("학교/물리/물리.pdf")).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("afo.rules.v1:guest"))).toBeNull();
    await page.getByRole("button", { name: "브라우저에 저장" }).click();
    await trial.getByRole("link", { name: "선택한 폴더 미리보기로 돌아가기" }).click();
    await expect(page.getByText("학교/물리/물리.pdf")).toBeVisible();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("JSON and CSV exports include candidates and defend against spreadsheet formulas", async ({ page }) => {
  const root = await mkdtemp(join(tmpdir(), "afo-export-"));
  try {
    await writeFile(join(root, "=HYPERLINK.txt"), "private synthetic contents");
    await writeFile(join(root, "copy.txt"), "private synthetic contents");
    await choose(page, root);
    await page.getByRole("button", { name: "중복 검사 시작" }).click();
    await expect(page.getByText(/동일한 해시의 후보 1그룹/)).toBeVisible();
    let event = page.waitForEvent("download"); await page.getByRole("button", { name: "JSON 저장" }).click();
    const jsonText = await readFile((await (await event).path())!, "utf8");
    const data = JSON.parse(jsonText); expect(data.mode).toBe("preview-only");
    expect(data.duplicateCheck.groups[0]).toEqual(expect.arrayContaining(["=HYPERLINK.txt", "copy.txt"]));
    expect(jsonText).not.toContain("private synthetic contents");
    event = page.waitForEvent("download"); await page.getByRole("button", { name: "CSV 저장" }).click();
    const csv = await readFile((await (await event).path())!, "utf8");
    expect(csv).toContain('"\'=HYPERLINK.txt"'); expect(csv).toContain("중복 후보 그룹");
    expect(csv).not.toContain("private synthetic contents");
  } finally { await rm(root, { recursive: true, force: true }); }
});
