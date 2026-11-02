#!/bin/sh
# AFO 설치(macOS): curl -fsSL https://raw.githubusercontent.com/fakeminjun7321/AFO/main/install.sh | sh
# GitHub Releases의 실행 파일을 받아 SHA256SUMS와 대조한 뒤 ~/.afo/bin/afo에 둡니다. Node.js는 필요 없습니다.
# 환경 변수: AFO_VERSION(예: 0.1.0, 기본 최신), AFO_INSTALL(기본 ~/.afo), AFO_NO_MODIFY_PATH=1(셸 설정 파일을 고치지 않음),
#           AFO_DOWNLOAD_BASE(다운로드 주소를 바꿀 때, 검증용)
set -eu

repo="fakeminjun7321/AFO"
install_dir="${AFO_INSTALL:-$HOME/.afo}"
bin_dir="$install_dir/bin"

say() { printf '%s\n' "$*"; }
fail() { printf 'AFO 설치 오류: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || fail "이 스크립트는 macOS용입니다. Windows는 PowerShell에서: irm https://raw.githubusercontent.com/$repo/main/install.ps1 | iex"
case "$(uname -m)" in
  arm64) target="darwin-arm64" ;;
  x86_64)
    # Rosetta에서 실행한 셸이면 Apple Silicon용을 받습니다.
    if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then target="darwin-arm64"; else target="darwin-x64"; fi ;;
  *) fail "지원하지 않는 CPU입니다: $(uname -m)" ;;
esac
command -v curl >/dev/null 2>&1 || fail "curl이 필요합니다."

if [ -n "${AFO_DOWNLOAD_BASE:-}" ]; then base="$AFO_DOWNLOAD_BASE"
elif [ -n "${AFO_VERSION:-}" ]; then base="https://github.com/$repo/releases/download/v${AFO_VERSION#v}"
else base="https://github.com/$repo/releases/latest/download"; fi
archive="afo-$target.tar.gz"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM

say "AFO 내려받는 중: $archive"
curl -fsSL --proto '=https,http' "$base/$archive" -o "$tmp/$archive" || fail "$base/$archive 를 받지 못했습니다."
curl -fsSL --proto '=https,http' "$base/SHA256SUMS" -o "$tmp/SHA256SUMS" || fail "SHA256SUMS를 받지 못했습니다."
expected="$(awk -v f="$archive" '$2 == f { print $1 }' "$tmp/SHA256SUMS")"
actual="$(shasum -a 256 "$tmp/$archive" | awk '{ print $1 }')"
[ -n "$expected" ] && [ "$expected" = "$actual" ] || fail "받은 파일의 SHA-256이 SHA256SUMS와 다릅니다. 설치하지 않았습니다."

tar -xzf "$tmp/$archive" -C "$tmp" afo
"$tmp/afo" --version >/dev/null 2>&1 || fail "받은 afo를 실행할 수 없습니다. 설치하지 않았습니다."
mkdir -p "$bin_dir"
# mv로 새 파일로 바꿉니다(실행 중이던 서명된 파일을 덮어쓰지 않음).
mv -f "$tmp/afo" "$bin_dir/afo"
say "설치 완료: $("$bin_dir/afo" --version) → $bin_dir/afo"

case ":$PATH:" in
  *":$bin_dir:"*) say "이제 afo 를 입력하세요." ; exit 0 ;;
esac
line="export PATH=\"$bin_dir:\$PATH\""
if [ "${AFO_NO_MODIFY_PATH:-}" = "1" ]; then
  say "PATH에 추가하려면 셸 설정 파일에 다음 줄을 넣으세요:"
  say "  $line"
  exit 0
fi
case "$(basename "${SHELL:-zsh}")" in
  bash) rc="$HOME/.bash_profile" ;;
  *) rc="${ZDOTDIR:-$HOME}/.zshrc" ;;
esac
if ! grep -qsF "$line" "$rc"; then
  printf '\n# AFO\n%s\n' "$line" >> "$rc"
  say "$rc 에 PATH를 추가했습니다."
fi
say "새 터미널을 열거나 다음을 실행한 뒤 afo 를 입력하세요:"
say "  source \"$rc\""
