# Open AgenticOS: cài một lệnh cho Windows 10/11. Chạy từ thư mục repo trong PowerShell:
#   powershell -ExecutionPolicy Bypass -File .\install.ps1      hoặc      npm run setup
# Bước 1–2 ở đây (kiểm tra máy, cài thư viện); bước 3–7 ở src/setup/main.ts (.env, GenBot, nối bot, chạy app).
# Không cần quyền quản trị, không sửa biến môi trường hay hồ sơ PowerShell, không tắt SmartScreen. Xem CAI-DAT.md.
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $Root
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$DryRun = $args -contains '--dry-run'
$Resume = $args -contains '--resume'
if ($args -contains '--help' -or $args -contains '-h') {
  Write-Output 'Cách dùng: .\install.ps1 [--update-genbot] [--resume] [--dry-run] [--no-open] [--no-start]'
  Write-Output 'Chi tiết: CAI-DAT.md'
  exit 0
}

function Say([string]$t) { Write-Output $t }
function Ok([string]$t) { Write-Output "  ✓ $t" }
function Note([string]$t) { Write-Output "  • $t" }
function Fail([string]$t) { Write-Output "  ✗ $t" }

Say 'Open AgenticOS: cài đặt'
if ($DryRun) { Say 'Chế độ thử (--dry-run): không tải, không cài, không ghi file, không mở app.' }

# ---------------------------------------------------------------- 1. kiểm tra máy
Say ''
Say '▸ [1/7] Kiểm tra máy'
$os = [System.Environment]::OSVersion.Version
if ($os.Major -lt 10) {
  Fail 'Cần Windows 10 hoặc 11.'
  exit 1
}
Ok "Windows $($os.Major).$($os.Build), $env:PROCESSOR_ARCHITECTURE"

$missing = $false
$hasWinget = [bool](Get-Command winget -ErrorAction SilentlyContinue)

if (Get-Command git -ErrorAction SilentlyContinue) {
  Ok "$(git --version)"
} else {
  Fail 'Chưa có git.'
  if ($hasWinget) { Note 'Cài: winget install --id Git.Git -e' } else { Note 'Tải ở https://git-scm.com/download/win' }
  $missing = $true
}

# Node: bản tối thiểu lấy từ "engines" trong package.json (ví dụ ">=22").
$needNode = 22
$engines = (Get-Content -Raw -LiteralPath (Join-Path $Root 'package.json') | ConvertFrom-Json).engines.node
if ($engines -match '(\d+)') { $needNode = [int]$Matches[1] }
function NodeHint {
  if ($hasWinget) { Note 'Cài: winget install --id OpenJS.NodeJS.LTS -e   (xong thì mở cửa sổ PowerShell mới rồi chạy lại)' }
  else { Note 'Tải bản LTS (file .msi) ở https://nodejs.org/en/download, cài, mở cửa sổ PowerShell mới rồi chạy lại.' }
}
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) {
  $haveNode = [int](node -p "process.versions.node.split('.')[0]")
  if ($haveNode -ge $needNode) { Ok "Node $(node -v) (cần $needNode trở lên)" }
  else { Fail "Node $(node -v) quá cũ, cần $needNode trở lên."; NodeHint; $missing = $true }
  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Fail 'Có Node nhưng thiếu npm. Cài lại Node.'; $missing = $true }
} else {
  Fail "Chưa có Node (cần $needNode trở lên)."
  NodeHint
  $missing = $true
}

# Dung lượng trống: thư viện của app (~1,5 GB) + GenBot (~270 MB tải về, ~1 GB sau khi cài).
$needGb = 3
$genbotExe = Join-Path $env:LOCALAPPDATA 'Programs\GenBot\GenBot.exe'
if (Test-Path -LiteralPath $genbotExe) { $needGb = 2 }
$drive = (Get-Item -LiteralPath $Root).PSDrive
$freeGb = [math]::Floor($drive.Free / 1GB)
if ($freeGb -ge $needGb) { Ok "Ổ $($drive.Name): còn trống $freeGb GB (cần khoảng $needGb GB)." }
else { Fail "Ổ $($drive.Name): chỉ còn $freeGb GB trống, cần khoảng $needGb GB."; $missing = $true }

if ($missing) {
  Say ''
  Say 'Thiếu điều kiện ở trên. Cài xong rồi chạy lại: npm run setup   (hoặc .\install.ps1)'
  exit 1
}

# ---------------------------------------------------------------- 2. thư viện của app
Say ''
Say '▸ [2/7] Cài thư viện của app (npm ci)'
$marker = Join-Path $Root 'node_modules\.aios-setup'
$tsx = Join-Path $Root 'node_modules\.bin\tsx.cmd'
$lockHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $Root 'package-lock.json')).Hash.ToLower()
$stamp = "$lockHash-node$(node -p 'process.versions.modules')"
$current = if (Test-Path -LiteralPath $marker) { (Get-Content -Raw -LiteralPath $marker).Trim() } else { '' }
if ($current -eq $stamp -and (Test-Path -LiteralPath $tsx)) {
  Ok 'Thư viện đã cài và khớp package-lock.json; bỏ qua.'
} elseif ($Resume -and (Test-Path -LiteralPath $tsx)) {
  Ok 'Chạy tiếp (--resume): giữ thư viện đang có.'
} elseif ($DryRun) {
  Note '(thử) Sẽ chạy: npm ci (chỉ cho app; không cài cloud/ hay mobile/).'
  if (-not (Test-Path -LiteralPath $tsx)) {
    Say ''
    Say 'Chế độ thử dừng ở đây vì chưa có thư viện để chạy các bước sau. Chạy lại không có --dry-run để cài.'
    exit 0
  }
} else {
  Note 'Chạy npm ci (vài phút ở lần đầu)…'
  & npm ci --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { Fail "npm ci lỗi (mã $LASTEXITCODE)."; exit 1 }
  Set-Content -LiteralPath $marker -Value $stamp -NoNewline -Encoding ascii
  Ok 'Đã cài thư viện.'
}

# ---------------------------------------------------------------- 3–7
& $tsx (Join-Path $Root 'src\setup\main.ts') @args
exit $LASTEXITCODE
