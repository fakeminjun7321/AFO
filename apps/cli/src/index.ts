import { readFile, lstat } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { ProfileSchema } from '../../../packages/contracts/src/index.js';
import { confirmProfile, suggestProfile } from '../../../packages/engine/src/index.js';
import { analyzeFolder, scanFolder } from '../../../packages/filesystem/src/index.js';

const help = `AFO 읽기 전용 미리보기

preview <폴더> [--profile <JSON>] [--reference <참고 폴더>] [--json]
suggest-rules <참고 폴더>
confirm-rules <규칙 JSON> --select <규칙 ID,규칙 ID>

이 버전은 파일을 읽고 결과를 출력합니다. 이동·삭제·자동 저장은 수행하지 않습니다.
`;
async function loadProfile(file: string): Promise<ReturnType<typeof ProfileSchema.parse>> {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
    throw new Error('규칙 JSON은 1 MiB 이하의 일반 파일이어야 합니다.');
  return ProfileSchema.parse(JSON.parse(await readFile(file, 'utf8')) as unknown);
}

export async function run(args: string[], signal?: AbortSignal): Promise<string> {
  if (args.length === 0 || args[0] === '--help') return help;
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    profile: { type: 'string' }, reference: { type: 'string' }, select: { type: 'string' }, json: { type: 'boolean' },
  } });
  const [command, target] = positionals;
  if (positionals.length !== 2 || !target) throw new Error('명령과 대상 폴더 또는 규칙 파일을 명시하세요. --help 참고');
  const options = signal ? { signal } : {};
  if (command === 'suggest-rules') {
    if (Object.keys(values).length) throw new Error('suggest-rules에는 추가 옵션을 사용할 수 없습니다.');
    return JSON.stringify(suggestProfile(await scanFolder(target, options)), null, 2);
  }
  if (command === 'confirm-rules') {
    if (!values.select || values.profile || values.reference || values.json)
      throw new Error('--select로 확인할 규칙 ID만 명시하세요.');
    return JSON.stringify(confirmProfile(await loadProfile(target), values.select.split(',')), null, 2);
  }
  if (command === 'preview') {
    if (values.select) throw new Error('preview에는 --select를 사용할 수 없습니다.');
    const config = { ...options,
      ...(values.profile ? { profile: await loadProfile(values.profile) } : {}),
      ...(values.reference ? { reference: values.reference } : {}) };
    const result = await analyzeFolder(target, config);
    if (values.json) return JSON.stringify(result, null, 2);
    const { preview } = result;
    const labels = { move: '이동 제안', keep: '유지', review: '검토 필요' };
    return ['AFO 정리 미리보기 — 실제 파일은 변경하지 않았습니다.',
      `분석: ${preview.items.length}개 / 스캔 ${preview.scanComplete ? '완료' : '일부 미완료'} / 제외·오류 ${preview.skipped.length}개`,
      ...preview.items.map((item) => `[${labels[item.action]}] ${item.source}${item.destination ? ` → ${item.destination}` : ''}\n  ${item.reason}`),
      ...preview.duplicates.map((group) => `[중복 후보] 남길 파일 제안: ${group.suggestedKeep}\n  확인할 파일: ${group.candidates.join(', ')} / 논리 크기 ${group.logicalCandidateBytes} B (확보량 아님)`),
      ...(result.suggestedProfile ? [`참고 규칙 후보: ${result.suggestedProfile.rules.length}개. 확인 전에는 적용하지 않습니다.`] : []),
      '실행 기능: 미구현. 파일 이동·삭제는 수행하지 않습니다.'].join('\n');
  }
  throw new Error('지원하지 않는 명령입니다. --help 참고');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  try { console.log(await run(process.argv.slice(2), controller.signal)); }
  catch (error) {
    const message = error instanceof Error ? error.message : '알 수 없는 오류';
    console.error(`AFO 오류: ${message}`);
    process.exitCode = error instanceof Error && error.name === 'AbortError' ? 130 : 1;
  }
}
