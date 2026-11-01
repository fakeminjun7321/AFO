#!/usr/bin/env node
// AFO 데모·수동 검증용 무작위 합성 파일 세트 생성기.
// 사용: node scripts/gen-random-testset.mjs [출력폴더=testset/random] [파일수=400] [seed]
// 실제 사용자 자료는 쓰지 않으며, 지정한 출력 폴더 안에만 파일을 만든다.
import { mkdirSync, writeFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { createHash } from "node:crypto";

const repo = resolve(import.meta.dirname, "..");
const out = resolve(repo, process.argv[2] ?? "testset/random");
const count = Number(process.argv[3] ?? 400);
const seed = Number(process.argv[4] ?? Date.now() % 2 ** 31);

if (relative(repo, out).startsWith("..") || out === repo) {
  console.error("출력 폴더는 AFO 저장소 하위여야 합니다.");
  process.exit(1);
}
if (existsSync(out) && readdirSync(out).length > 0) {
  if (!existsSync(join(out, "MANIFEST.json"))) {
    console.error("비어 있지 않고 생성기가 만든 폴더가 아니라 중단합니다:", out);
    process.exit(1);
  }
  rmSync(out, { recursive: true });
}

// mulberry32: seed가 같으면 같은 세트를 재현한다.
let s = seed >>> 0;
const rand = () => {
  s = (s + 0x6d2b79f5) >>> 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
};
const pick = (a) => a[Math.floor(rand() * a.length)];
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

const kinds = {
  document: { ext: ["pdf", "docx", "hwp", "txt", "pptx", "xlsx", "md", "csv"], magic: { pdf: "%PDF-1.7\n" } },
  image: { ext: ["jpg", "jpeg", "png", "gif", "heic", "webp"], magic: { png: "\x89PNG\r\n\x1a\n", jpg: "\xff\xd8\xff\xe0", gif: "GIF89a" } },
  video: { ext: ["mp4", "mov", "mkv", "avi"], magic: {} },
  audio: { ext: ["mp3", "wav", "m4a", "flac"], magic: { mp3: "ID3" } },
  archive: { ext: ["zip", "7z", "rar", "tar.gz"], magic: { zip: "PK\x03\x04" } },
  installer: { ext: ["dmg", "exe", "msi", "pkg"], magic: {} },
  other: { ext: ["", "bak", "tmp", "xyz", "dat", "log"], magic: {} },
};
const words = ["과제", "보고서", "수행평가", "기말", "중간고사", "발표", "회의록", "영수증", "사진", "캡처",
  "Screenshot", "IMG", "report", "final", "final_진짜최종", "copy", "새 파일", "다운로드", "수학", "물리",
  "동아리", "포스터", "녹음", "vlog", "setup", "installer", "backup", "untitled", "😀메모", "Résumé", "data"];
const dirs = ["", "", "", "Downloads", "Desktop정리안됨", "학교/2학기/수학", "학교/2학기/국어", "동아리",
  "사진/2026/여름", "잡동사니", "새 폴더", "새 폴더 (2)", "프로젝트 자료/참고", "임시", "😀 기타", "deep/a/b/c/d/e"];

const manifest = [];
const pool = [];
const write = (rel, buf, note) => {
  const p = join(out, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  if (existsSync(p)) return false;
  writeFileSync(p, buf);
  manifest.push({ path: rel, size: buf.length, sha256: createHash("sha256").update(buf).digest("hex"), note });
  return true;
};
const body = (kind, ext) => {
  const head = Buffer.from(kinds[kind].magic[ext] ?? "", "latin1");
  // 대부분 작고, 일부만 큰 파일. 최대 약 3 MiB.
  const size = rand() < 0.05 ? int(1 << 20, 3 << 20) : rand() < 0.3 ? int(0, 64) : int(100, 40_000);
  const b = Buffer.alloc(size);
  for (let i = 0; i < size; i++) b[i] = Math.floor(rand() * 256);
  return Buffer.concat([head, b]);
};

for (let i = 0; i < count; i++) {
  const kind = pick(Object.keys(kinds));
  let ext = pick(kinds[kind].ext);
  const r = rand();
  if (ext && r < 0.12) ext = ext.toUpperCase(); // 대소문자 확장자
  let name = `${pick(words)}${rand() < 0.6 ? `_${int(1, 999)}` : ""}${rand() < 0.1 ? " (1)" : ""}`;
  if (rand() < 0.05) name = `.${name}`; // 숨김 파일
  if (rand() < 0.04) ext = `${ext || "txt"}.${pick(["bak", "zip", "pdf"])}`; // 이중 확장자
  const rel = join(pick(dirs), ext ? `${name}.${ext}` : name);

  // 15%는 기존 파일 내용을 복사한 중복(다른 이름/같은 내용)
  if (pool.length && rand() < 0.15) {
    const src = pick(pool);
    write(rel, src.buf, `duplicate-of:${src.rel}`);
    continue;
  }
  const buf = body(kind, ext.toLowerCase());
  if (write(rel, buf, `kind:${kind}`)) pool.push({ rel, buf });
}

// 꼭 들어가야 할 경계 사례
write("같은이름/report.pdf", Buffer.from("%PDF-1.7\nA"), "same-name-diff-content");
write("같은이름/다른폴더/report.pdf", Buffer.from("%PDF-1.7\nB"), "same-name-diff-content");
write("빈파일_1.txt", Buffer.alloc(0), "empty");
write("빈파일_2.log", Buffer.alloc(0), "empty-duplicate");
write("node_project/package.json", Buffer.from("{}"), "dev-project-should-be-excluded");
write("node_project/index.js", Buffer.from("console.log(1)"), "dev-project-should-be-excluded");
write("Fake.app/Contents/Info.plist", Buffer.from("<plist/>"), "app-bundle-should-be-excluded");
mkdirSync(join(out, "빈 폴더"), { recursive: true });

writeFileSync(join(out, "MANIFEST.json"), JSON.stringify({ seed, count: manifest.length, files: manifest }, null, 2));
console.log(`생성 완료: ${relative(repo, out)} — 파일 ${manifest.length}개, seed ${seed}`);
