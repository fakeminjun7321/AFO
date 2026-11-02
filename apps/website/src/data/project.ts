/** Public project links and install commands. Keep in sync with the root README. */
export const repo = "https://github.com/fakeminjun7321/AFO";
export const links = {
  repo,
  issues: `${repo}/issues`,
  newIssue: `${repo}/issues/new`,
  pulls: `${repo}/pulls`,
  releases: `${repo}/releases`,
  latestRelease: `${repo}/releases/latest`,
  license: `${repo}/blob/main/LICENSE`,
  readme: `${repo}#readme`,
  cliDocs: `${repo}/blob/main/docs/CLI.md`,
  development: `${repo}/blob/main/docs/DEVELOPMENT.md`,
  verification: `${repo}/tree/main/docs/verification`,
  plan: `${repo}/issues/1`,
};
export const pr = (n: number) => `${repo}/pull/${n}`;
export const issue = (n: number) => `${repo}/issues/${n}`;
export const doc = (path: string) => `${repo}/blob/main/${path}`;

export type InstallOs = "mac" | "windows";
export const installCommands: Record<InstallOs, { label: string; shell: string; command: string }> = {
  mac: {
    label: "macOS",
    shell: "터미널",
    command: "curl -fsSL https://raw.githubusercontent.com/fakeminjun7321/AFO/main/install.sh | sh",
  },
  windows: {
    label: "Windows",
    shell: "PowerShell",
    command: "irm https://raw.githubusercontent.com/fakeminjun7321/AFO/main/install.ps1 | iex",
  },
};
