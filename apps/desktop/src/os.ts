import { execFile } from 'node:child_process';

/** Which folder the user is choosing. Only used for the dialog prompt text. */
export type FolderKind = 'work' | 'reference';
/** Native folder dialog: absolute path, or null when the user cancels. Never throws for a cancel. */
export type FolderPicker = (kind: FolderKind) => Promise<string | null>;

const prompts: Record<FolderKind, string> = { work: 'AFO: 정리할 작업 폴더를 선택하세요', reference: 'AFO: 참고할 폴더를 선택하세요(읽기만 합니다)' };
const PICKER_TIMEOUT_MS = 10 * 60 * 1000;

interface Run { stdout: string; stderr: string; code: number | string | null }
const run = (file: string, args: string[]): Promise<Run> => new Promise((resolve) => {
  // shell:false (execFile default); arguments are passed as an array, never joined into a command line.
  execFile(file, args, { shell: false, windowsHide: false, timeout: PICKER_TIMEOUT_MS, encoding: 'utf8', maxBuffer: 64 * 1024 },
    (error, stdout, stderr) => resolve({ stdout, stderr, code: error === null ? 0 : (error as NodeJS.ErrnoException).code ?? 1 }));
});

export class PickerUnavailable extends Error {}

/** macOS osascript `choose folder`, Windows PowerShell FolderBrowserDialog (-STA). Other OS: unavailable (type the path). */
export const nativeFolderPicker: FolderPicker = async (kind) => {
  if (process.platform === 'darwin') {
    // Prompt strings are constants without quotes; no user data enters the script.
    const result = await run('/usr/bin/osascript', ['-e', `POSIX path of (choose folder with prompt "${prompts[kind]}")`]);
    if (result.code === 0) return result.stdout.replace(/\r?\n$/u, '').replace(/(.)\/$/u, '$1') || null;
    if (/-128/u.test(result.stderr)) return null; // "User canceled. (-128)"
    throw new PickerUnavailable('폴더 선택 대화상자를 열지 못했습니다. 경로를 직접 입력하세요.');
  }
  if (process.platform === 'win32') {
    const script = ['[Console]::OutputEncoding = [System.Text.Encoding]::UTF8', 'Add-Type -AssemblyName System.Windows.Forms',
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog', `$d.Description = '${prompts[kind]}'`,
      '$d.ShowNewFolderButton = $false', "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $d.SelectedPath }"].join('; ');
    const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script]);
    if (result.code !== 0) throw new PickerUnavailable('폴더 선택 대화상자를 열지 못했습니다. 경로를 직접 입력하세요.');
    return result.stdout.replace(/^﻿/u, '').trim() || null;
  }
  throw new PickerUnavailable('이 OS에서는 폴더 선택 대화상자를 지원하지 않습니다. 경로를 직접 입력하세요.');
};

/** Opens the URL in the default browser without a shell. Resolves false when it could not. */
export async function openBrowser(url: string): Promise<boolean> {
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}\/#t=[A-Za-z0-9_-]+$/u.test(url)) return false;
  const command = process.platform === 'darwin' ? ['/usr/bin/open', url] : process.platform === 'win32' ? ['explorer.exe', url] : null;
  if (command === null) return false;
  const result = await run(command[0]!, command.slice(1));
  // explorer.exe returns 1 even when it opened the URL.
  return result.code === 0 || (process.platform === 'win32' && result.code === 1);
}
