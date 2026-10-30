import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { CLASSIFICATION_VERSION, ClassificationReasonSchema } from '../packages/contracts/src/index.js';
import { categoryExtensions, defaultCategory, extensionOfName, incompleteDownloadExtensions } from '../packages/engine/src/defaults.js';
import { buildPreview, classifyFile, confirmProfile, suggestProfile } from '../packages/engine/src/index.js';
import { scanFixture } from './helpers.js';

/**
 * default-3 table, written out by hand (not derived from defaults.ts): every new category has at least two examples,
 * ambiguous extensions stay "확인 필요", ".tar.<x>" is one archive, two known extensions stay ambiguous, unfinished downloads are kept.
 */
const oracle: [string, string | null, string][] = [
  // 문서 additions
  ['서식.RTF', '문서', 'DEFAULT_EXTENSION'], ['발표.key', '문서', 'DEFAULT_EXTENSION'], ['표.numbers', '문서', 'DEFAULT_EXTENSION'],
  ['양식.hwt', '문서', 'DEFAULT_EXTENSION'], ['매크로.xlsm', '문서', 'DEFAULT_EXTENSION'], ['한쇼.show', '문서', 'DEFAULT_EXTENSION'],
  ['논문.tex', '문서', 'DEFAULT_EXTENSION'], ['인쇄.xps', '문서', 'DEFAULT_EXTENSION'],
  // 이미지 / 영상 / 음악 / 압축 / 설치 additions
  ['scan.BMP', '이미지', 'DEFAULT_EXTENSION'], ['IMG_0001.CR3', '이미지', 'DEFAULT_EXTENSION'], ['photo.avif', '이미지', 'DEFAULT_EXTENSION'],
  ['DSC.nef', '이미지', 'DEFAULT_EXTENSION'], ['pic.jfif', '이미지', 'DEFAULT_EXTENSION'],
  ['lecture.m4v', '영상', 'DEFAULT_EXTENSION'], ['old.wmv', '영상', 'DEFAULT_EXTENSION'], ['영화.srt', '영상', 'DEFAULT_EXTENSION'],
  ['영화.smi', '영상', 'DEFAULT_EXTENSION'], ['cam.MTS', '영상', 'DEFAULT_EXTENSION'],
  ['voice.aac', '음악', 'DEFAULT_EXTENSION'], ['song.opus', '음악', 'DEFAULT_EXTENSION'], ['tune.MIDI', '음악', 'DEFAULT_EXTENSION'],
  ['녹음.amr', '음악', 'DEFAULT_EXTENSION'],
  ['logs.bz2', '압축', 'DEFAULT_EXTENSION'], ['자료.alz', '압축', 'DEFAULT_EXTENSION'], ['자료.egg', '압축', 'DEFAULT_EXTENSION'],
  ['src.tar.xz', '압축', 'DEFAULT_EXTENSION'], ['src.tar.bz2', '압축', 'DEFAULT_EXTENSION'], ['SRC.TAR.ZST', '압축', 'DEFAULT_EXTENSION'],
  ['backup.tar.gz', '압축', 'DEFAULT_EXTENSION'], ['pack.txz', '압축', 'DEFAULT_EXTENSION'],
  ['app.apk', '설치', 'DEFAULT_EXTENSION'], ['tool.deb', '설치', 'DEFAULT_EXTENSION'], ['ubuntu.iso', '설치', 'DEFAULT_EXTENSION'],
  ['App.AppImage', '설치', 'DEFAULT_EXTENSION'],
  // New categories
  ['포스터.psd', '디자인', 'DEFAULT_EXTENSION'], ['logo.ai', '디자인', 'DEFAULT_EXTENSION'], ['화면.fig', '디자인', 'DEFAULT_EXTENSION'],
  ['model.stl', '디자인', 'DEFAULT_EXTENSION'], ['scene.blend', '디자인', 'DEFAULT_EXTENSION'],
  ['나눔.ttf', '글꼴', 'DEFAULT_EXTENSION'], ['Pretendard.OTF', '글꼴', 'DEFAULT_EXTENSION'], ['web.woff2', '글꼴', 'DEFAULT_EXTENSION'],
  ['소설.epub', '전자책', 'DEFAULT_EXTENSION'], ['book.mobi', '전자책', 'DEFAULT_EXTENSION'], ['kindle.azw3', '전자책', 'DEFAULT_EXTENSION'],
  ['hw1.py', '코드', 'DEFAULT_EXTENSION'], ['실습.ipynb', '코드', 'DEFAULT_EXTENSION'], ['main.c', '코드', 'DEFAULT_EXTENSION'],
  ['Main.java', '코드', 'DEFAULT_EXTENSION'], ['index.html', '코드', 'DEFAULT_EXTENSION'], ['run.sh', '코드', 'DEFAULT_EXTENSION'],
  ['app.min.js', '코드', 'DEFAULT_EXTENSION'],
  ['config.json', '데이터', 'DEFAULT_EXTENSION'], ['data.yml', '데이터', 'DEFAULT_EXTENSION'], ['app.sqlite3', '데이터', 'DEFAULT_EXTENSION'],
  ['server.log', '데이터', 'DEFAULT_EXTENSION'], ['table.tsv', '데이터', 'DEFAULT_EXTENSION'],
  // Ambiguous or risky: still "확인 필요"
  ['types.ts', null, 'UNKNOWN_EXTENSION'], ['script.m', null, 'UNKNOWN_EXTENSION'], ['firmware.bin', null, 'UNKNOWN_EXTENSION'],
  ['game.dat', null, 'UNKNOWN_EXTENSION'], ['cache.tmp', null, 'UNKNOWN_EXTENSION'], ['바로가기.lnk', null, 'UNKNOWN_EXTENSION'],
  ['site.url', null, 'UNKNOWN_EXTENSION'], ['page.webloc', null, 'UNKNOWN_EXTENSION'], ['폴더.alias', null, 'UNKNOWN_EXTENSION'],
  ['data.xyz', null, 'UNKNOWN_EXTENSION'], ['Makefile', null, 'NO_EXTENSION'], ['메모', null, 'NO_EXTENSION'],
  // Two known extensions: ambiguous, as before (and now more names are known on the inside)
  ['report.pdf.exe', null, 'COMPOUND_EXTENSION'], ['photo.jpg.zip', null, 'COMPOUND_EXTENSION'], ['a.tar.zip', null, 'COMPOUND_EXTENSION'],
  ['dump.sql.gz', null, 'COMPOUND_EXTENSION'],
  // Unfinished downloads, even with a known extension inside
  ['movie.mp4.part', null, 'INCOMPLETE_DOWNLOAD'], ['setup.exe.crdownload', null, 'INCOMPLETE_DOWNLOAD'], ['big.CRDOWNLOAD', null, 'INCOMPLETE_DOWNLOAD'],
  ['file.part', null, 'INCOMPLETE_DOWNLOAD'], ['archive.zip.download', null, 'INCOMPLETE_DOWNLOAD'],
];

test('default-3: hand-written extension table for every category, ambiguous exclusions, .tar.<x>, compound and unfinished downloads', () => {
  assert.equal(CLASSIFICATION_VERSION, 'default-3');
  for (const [name, category, reason] of oracle) {
    const c = classifyFile(name);
    assert.deepEqual([c.category, c.targetDirectory, c.reasonCode], [category, category, reason], name);
    // The browser preview (apps/website) imports defaultCategory: same answer.
    assert.deepEqual([defaultCategory(name).category, defaultCategory(name).reason], [category, reason], `browser: ${name}`);
    assert.equal(extensionOfName(name), path.posix.extname(name).toLowerCase(), name);
  }
  assert.match(classifyFile('movie.mp4.part').reason, /다운로드가 끝나지 않은 파일일 수 있어/u);
  assert.match(classifyFile('hw1.py').reason, /default-3/u);
  assert.ok(ClassificationReasonSchema.safeParse('INCOMPLETE_DOWNLOAD').success);
});

test('default-3 table: one category per extension, lower-case contract-valid extensions, old category names kept, no ambiguous ones', () => {
  const all = Object.values(categoryExtensions).flat();
  assert.equal(new Set(all).size, all.length, 'no extension in two categories');
  for (const ext of [...all, ...incompleteDownloadExtensions]) assert.match(`.${ext}`, /^\.[a-z0-9]{1,16}$/u, ext);
  for (const ext of incompleteDownloadExtensions) assert.ok(!all.includes(ext), ext);
  assert.deepEqual(Object.keys(categoryExtensions), ['문서', '이미지', '영상', '음악', '압축', '설치', '디자인', '글꼴', '전자책', '코드', '데이터']);
  for (const ext of ['ts', 'm', 'bin', 'dat', 'tmp', 'lnk', 'url', 'webloc', 'alias', 'part', 'crdownload', 'download'])
    assert.ok(!all.includes(ext), `${ext} is not a default category`);
});

test('personal rules do not move unfinished downloads; a one-off override still can', () => {
  const draft = suggestProfile(scanFixture(['받은/a.part', '받은/b.part', '받은/c.part']));
  const profile = confirmProfile(draft, draft.rules.map((r) => r.id));
  assert.ok(profile.rules.some((r) => r.extension === '.part'), 'the reference folder suggested a .part rule');
  assert.equal(classifyFile('new.part', { profile }).reasonCode, 'INCOMPLETE_DOWNLOAD');
  assert.equal(classifyFile('new.part', { override: '받은' }).targetDirectory, '받은');
  const preview = buildPreview(scanFixture(['movie.mp4.crdownload', 'a.pdf']));
  assert.deepEqual(Object.fromEntries(preview.items.map((i) => [i.source, [i.action, i.reasonCode]])),
    { 'movie.mp4.crdownload': ['review', 'INCOMPLETE_DOWNLOAD'], 'a.pdf': ['move', 'DEFAULT_EXTENSION'] });
});
