#!/bin/sh
# AFO 설치(macOS): curl -fsSL https://raw.githubusercontent.com/fakeminjun7321/AFO/main/install.sh | sh
# GitHub Releases의 실행 파일을 받아 SHA256SUMS와 대조한 뒤 ~/.afo/bin/afo에 둡니다. Node.js는 필요 없습니다.
# Finder 빠른 동작 "AFO로 정리"(~/Library/Services/AFO로 정리.workflow)도 만듭니다: 폴더를 오른쪽 클릭 → afo gui <폴더> --exit-when-closed.
# 환경 변수: AFO_VERSION(예: 0.1.0, 기본 최신), AFO_INSTALL(기본 ~/.afo), AFO_NO_MODIFY_PATH=1(셸 설정 파일을 고치지 않음),
#           AFO_NO_QUICK_ACTION=1(빠른 동작을 만들지 않음), AFO_DOWNLOAD_BASE(다운로드 주소를 바꿀 때, 검증용)
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

# Finder 빠른 동작: 선택한 폴더마다 afo gui를 터미널 없이 띄우고(분리 실행이라 바로 돌아옴), 브라우저 화면을 닫으면 afo도 끝납니다.
# 표식(AFOCreatedBy)이 있는, AFO가 만든 workflow만 덮어씁니다.
quick_action() {
  services="$HOME/Library/Services"
  workflow="$services/AFO로 정리.workflow"
  if [ -e "$workflow" ] && ! grep -qs '<key>AFOCreatedBy</key>' "$workflow/Contents/Info.plist"; then
    say "빠른 동작을 만들지 않았습니다: $workflow 가 이미 있고 AFO가 만든 것이 아닙니다."
    return 0
  fi
  # 셸 작은따옴표 안에 넣은 뒤 XML로 escape합니다(경로에 공백·따옴표·&가 있어도 그대로 전달).
  quoted="'$(printf '%s' "$bin_dir/afo" | sed "s/'/'\\\\''/g")'"
  script="afo=$quoted
for f in \"\$@\"; do
  if [ -d \"\$f\" ]; then
    \"\$afo\" gui \"\$f\" --exit-when-closed </dev/null >/dev/null 2>&1 &!
  fi
done"
  xml="$(printf '%s' "$script" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g')"
  mkdir -p "$workflow/Contents" || { say "빠른 동작을 만들지 못했습니다($workflow)."; return 0; }
  cat > "$workflow/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>AFOCreatedBy</key>
	<string>AFO install.sh</string>
	<key>NSServices</key>
	<array>
		<dict>
			<key>NSMenuItem</key>
			<dict>
				<key>default</key>
				<string>AFO로 정리</string>
			</dict>
			<key>NSMessage</key>
			<string>runWorkflowAsService</string>
			<key>NSRequiredContext</key>
			<dict>
				<key>NSApplicationIdentifier</key>
				<string>com.apple.finder</string>
			</dict>
			<key>NSSendFileTypes</key>
			<array>
				<string>public.folder</string>
			</array>
		</dict>
	</array>
</dict>
</plist>
PLIST
  cat > "$workflow/Contents/document.wflow" <<WFLOW
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>AMApplicationBuild</key>
	<string>523</string>
	<key>AMApplicationVersion</key>
	<string>2.10</string>
	<key>AMDocumentVersion</key>
	<string>2</string>
	<key>actions</key>
	<array>
		<dict>
			<key>action</key>
			<dict>
				<key>AMAccepts</key>
				<dict>
					<key>Container</key>
					<string>List</string>
					<key>Optional</key>
					<true/>
					<key>Types</key>
					<array>
						<string>com.apple.cocoa.string</string>
					</array>
				</dict>
				<key>AMActionVersion</key>
				<string>2.0.3</string>
				<key>AMApplication</key>
				<array>
					<string>Automator</string>
				</array>
				<key>AMProvides</key>
				<dict>
					<key>Container</key>
					<string>List</string>
					<key>Types</key>
					<array>
						<string>com.apple.cocoa.string</string>
					</array>
				</dict>
				<key>ActionBundlePath</key>
				<string>/System/Library/Automator/Run Shell Script.action</string>
				<key>ActionName</key>
				<string>Run Shell Script</string>
				<key>ActionParameters</key>
				<dict>
					<key>COMMAND_STRING</key>
					<string>$xml</string>
					<key>CheckedForUserDefaultShell</key>
					<true/>
					<key>inputMethod</key>
					<integer>1</integer>
					<key>shell</key>
					<string>/bin/zsh</string>
					<key>source</key>
					<string></string>
				</dict>
				<key>BundleIdentifier</key>
				<string>com.apple.RunShellScript</string>
				<key>CFBundleVersion</key>
				<string>2.0.3</string>
				<key>Class Name</key>
				<string>RunShellScriptAction</string>
				<key>InputUUID</key>
				<string>6A1C4B5E-3B7F-4C55-9A0B-AF0000000001</string>
				<key>OutputUUID</key>
				<string>6A1C4B5E-3B7F-4C55-9A0B-AF0000000002</string>
				<key>UUID</key>
				<string>6A1C4B5E-3B7F-4C55-9A0B-AF0000000003</string>
			</dict>
			<key>isViewVisible</key>
			<integer>1</integer>
		</dict>
	</array>
	<key>connectors</key>
	<dict/>
	<key>workflowMetaData</key>
	<dict>
		<key>serviceApplicationBundleID</key>
		<string>com.apple.finder</string>
		<key>serviceApplicationPath</key>
		<string>/System/Library/CoreServices/Finder.app</string>
		<key>serviceInputTypeIdentifier</key>
		<string>com.apple.Automator.fileSystemObject.folder</string>
		<key>serviceOutputTypeIdentifier</key>
		<string>com.apple.Automator.nothing</string>
		<key>serviceProcessesInput</key>
		<integer>0</integer>
		<key>workflowTypeIdentifier</key>
		<string>com.apple.Automator.servicesMenu</string>
	</dict>
</dict>
</plist>
WFLOW
  # 서비스 메뉴 목록을 새로 읽게 합니다(실패해도 다음 로그인 때 나타남).
  /System/Library/CoreServices/pbs -update >/dev/null 2>&1 || true
  say "Finder 빠른 동작을 만들었습니다: 폴더를 오른쪽 클릭 → 빠른 동작(또는 서비스) → AFO로 정리"
}
if [ "${AFO_NO_QUICK_ACTION:-}" = "1" ]; then say "빠른 동작은 만들지 않았습니다(AFO_NO_QUICK_ACTION=1)."
else quick_action; fi

case ":$PATH:" in
  *":$bin_dir:"*) say "이제 afo 를 입력하세요." ; exit 0 ;;
esac
line="export PATH=\"$bin_dir:\$PATH\""
if [ "${AFO_NO_MODIFY_PATH:-}" = "1" ]; then
  say "PATH에 추가하려면 셸 설정 파일에 다음 줄을 넣으세요:"
  say "  $line"
  exit 0
fi
# 이미 PATH에 있는 쓰기 가능한 폴더에 링크를 두면 설치한 그 터미널에서도 바로 afo를 쓸 수 있습니다.
for dir in "$HOME/.local/bin" /opt/homebrew/bin /usr/local/bin; do
  case ":$PATH:" in *":$dir:"*) ;; *) continue ;; esac
  [ -d "$dir" ] && [ -w "$dir" ] || continue
  # 다른 프로그램의 afo는 건드리지 않습니다.
  if [ -e "$dir/afo" ] || [ -L "$dir/afo" ]; then
    [ "$(readlink "$dir/afo")" = "$bin_dir/afo" ] || continue
  fi
  ln -sf "$bin_dir/afo" "$dir/afo"
  say "$dir/afo 에 연결했습니다. 이 터미널에서 바로 afo 를 입력하세요."
  exit 0
done
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
