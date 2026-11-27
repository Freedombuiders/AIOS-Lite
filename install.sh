#!/usr/bin/env bash
# Open AgenticOS: cài một lệnh cho macOS (Apple Silicon). Chạy từ thư mục repo:  ./install.sh   hoặc   npm run setup
# Bước 1–2 ở đây (kiểm tra máy, cài thư viện); bước 3–7 ở src/setup/main.ts (.env, GenBot, nối bot, chạy app).
# Không dùng sudo (trừ khi bạn thêm --system), không sửa file cấu hình shell, không tắt Gatekeeper.
# Xem CAI-DAT.md.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

DRY_RUN=0
RESUME=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --resume) RESUME=1 ;;
    --help|-h)
      echo "Cách dùng: ./install.sh [--update-genbot] [--resume] [--dry-run] [--system] [--no-open] [--no-start]"
      echo "Chi tiết: CAI-DAT.md"
      exit 0 ;;
  esac
done

say()  { printf '%s\n' "$*"; }
ok()   { printf '  ✓ %s\n' "$*"; }
note() { printf '  • %s\n' "$*"; }
fail() { printf '  ✗ %s\n' "$*"; }

say "Open AgenticOS: cài đặt"
[ "$DRY_RUN" = 1 ] && say "Chế độ thử (--dry-run): không tải, không cài, không ghi file, không mở app."

# ---------------------------------------------------------------- 1. kiểm tra máy
say ""
say "▸ [1/7] Kiểm tra máy"

OS="$(uname -s)"
case "$OS" in
  Darwin)
    if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = "1" ]; then
      ok "macOS $(sw_vers -productVersion 2>/dev/null || echo '?'), chip Apple Silicon."
    else
      note "Mac chip Intel: GenBot chưa có bản cho máy này. Open AgenticOS vẫn được cài; bước 4 sẽ nói cách dùng GenBot ở máy khác."
    fi ;;
  Linux)
    note "Linux: GenBot chưa có bản cho Linux. Open AgenticOS vẫn được cài; bước 4 sẽ nói cách dùng GenBot ở máy khác." ;;
  *)
    fail "Hệ điều hành $OS chưa được hỗ trợ. Trên Windows hãy chạy install.ps1 trong PowerShell."
    exit 1 ;;
esac

missing=0

if command -v git >/dev/null 2>&1; then
  ok "git $(git --version | awk '{print $3}')"
else
  fail "Chưa có git."
  if [ "$OS" = Darwin ]; then note "Cài: xcode-select --install"; else note "Cài git bằng trình quản lý gói của máy (ví dụ: sudo apt install git)."; fi
  missing=1
fi

# Node: bản tối thiểu lấy từ "engines" trong package.json (ví dụ ">=22").
NEED_NODE="$(sed -n 's/.*"node"[[:space:]]*:[[:space:]]*"[^0-9]*\([0-9][0-9]*\).*/\1/p' package.json | head -n 1)"
NEED_NODE="${NEED_NODE:-22}"
node_install_hint() {
  if [ "$OS" = Darwin ]; then
    if command -v brew >/dev/null 2>&1; then
      note "Cài: brew install node"
    else
      note "Tải bản LTS (file .pkg) ở https://nodejs.org/en/download, cài, mở cửa sổ Terminal mới rồi chạy lại ./install.sh"
    fi
  else
    note "Cài Node $NEED_NODE trở lên theo https://nodejs.org/en/download (chọn trình quản lý gói của máy), rồi chạy lại ./install.sh"
  fi
}
if command -v node >/dev/null 2>&1; then
  HAVE_NODE="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$HAVE_NODE" -ge "$NEED_NODE" ]; then
    ok "Node $(node -v) (cần $NEED_NODE trở lên)"
  else
    fail "Node $(node -v) quá cũ, cần $NEED_NODE trở lên."
    node_install_hint
    missing=1
  fi
else
  fail "Chưa có Node (cần $NEED_NODE trở lên)."
  node_install_hint
  missing=1
fi
if command -v node >/dev/null 2>&1 && ! command -v npm >/dev/null 2>&1; then
  fail "Có Node nhưng thiếu npm. Cài lại Node từ https://nodejs.org hoặc bằng Homebrew."
  missing=1
fi

# Dung lượng trống: thư viện của app (~1,5 GB) + GenBot (~330 MB tải về, ~1 GB sau khi cài).
NEED_GB=3
if [ -d /Applications/GenBot.app ] || [ -d "$HOME/Applications/GenBot.app" ]; then NEED_GB=2; fi
FREE_KB="$(df -Pk "$ROOT" | awk 'NR==2 {print $4}')"
FREE_GB=$((FREE_KB / 1024 / 1024))
if [ "$FREE_GB" -ge "$NEED_GB" ]; then
  ok "Còn trống ${FREE_GB} GB (cần khoảng ${NEED_GB} GB)."
else
  fail "Chỉ còn ${FREE_GB} GB trống, cần khoảng ${NEED_GB} GB. Dọn bớt ổ đĩa rồi chạy lại."
  missing=1
fi

if [ "$missing" = 1 ]; then
  say ""
  say "Thiếu điều kiện ở trên. Cài xong rồi chạy lại: ./install.sh"
  exit 1
fi

# ---------------------------------------------------------------- 2. thư viện của app
say ""
say "▸ [2/7] Cài thư viện của app (npm ci)"
# Bỏ qua khi package-lock.json và bản Node (ABI của thư viện gốc như better-sqlite3) không đổi từ lần cài trước.
MARKER="node_modules/.aios-setup"
STAMP="$(shasum -a 256 package-lock.json | awk '{print $1}')-node$(node -p 'process.versions.modules')"
if [ -f "$MARKER" ] && [ "$(cat "$MARKER")" = "$STAMP" ] && [ -x node_modules/.bin/tsx ]; then
  ok "Thư viện đã cài và khớp package-lock.json; bỏ qua."
elif [ "$RESUME" = 1 ] && [ -x node_modules/.bin/tsx ]; then
  ok "Chạy tiếp (--resume): giữ thư viện đang có."
elif [ "$DRY_RUN" = 1 ]; then
  note "(thử) Sẽ chạy: npm ci (chỉ cho app; không cài cloud/ hay mobile/)."
  if [ ! -x node_modules/.bin/tsx ]; then
    say ""
    say "Chế độ thử dừng ở đây vì chưa có thư viện để chạy các bước sau. Chạy ./install.sh (không --dry-run) để cài."
    exit 0
  fi
else
  note "Chạy npm ci (vài phút ở lần đầu)…"
  npm ci --no-audit --no-fund
  printf '%s' "$STAMP" > "$MARKER"
  ok "Đã cài thư viện."
fi

# ---------------------------------------------------------------- 3–7
exec node_modules/.bin/tsx src/setup/main.ts "$@"
