import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { startServer } from './server.js';
import { openBrowser } from './os.js';

const help = `AFO 화면(읽기 전용 미리보기)

npm start [-- --no-open]

이 컴퓨터(127.0.0.1)에서만 열리는 화면을 띄우고 기본 브라우저로 엽니다.
--no-open  브라우저를 열지 않고 주소만 출력합니다.
읽기 전용: 파일을 이동·삭제하지 않습니다. 종료는 Ctrl+C.
`;

export async function main(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, strict: true, allowPositionals: false,
    options: { 'no-open': { type: 'boolean' }, help: { type: 'boolean' } } });
  if (values.help) { console.log(help); return; }
  const server = await startServer();
  console.log('AFO 화면을 시작했습니다. 읽기 전용: 파일을 이동·삭제하지 않습니다.');
  console.log(`주소(이 실행에서만 유효한 토큰 포함): ${server.url}`);
  if (!values['no-open']) {
    const opened = await openBrowser(server.url);
    console.log(opened ? '기본 브라우저에서 열었습니다.' : '브라우저를 열지 못했습니다. 위 주소를 브라우저에 붙여 넣으세요.');
  }
  console.log('종료하려면 Ctrl+C를 누르세요.');
  const stop = (): void => { void server.close().then(() => process.exit(0)); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(`AFO 화면 오류: ${error instanceof Error ? error.message : '알 수 없는 오류'}`);
    process.exitCode = 1;
  });
}
