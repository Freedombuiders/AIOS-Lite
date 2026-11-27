# Cài Open AgenticOS và GenBot

Một lệnh cài cả Open AgenticOS (app trong repo này) lẫn GenBot (bộ máy chạy bot, app desktop), rồi mở app để bạn nối bot.

## Lệnh cài

Tải repo về rồi chạy trong thư mục repo:

**macOS (Mac chip Apple Silicon M1 trở lên)**, trong Terminal:

```bash
git clone <địa chỉ repo> open-agenticos
cd open-agenticos
./install.sh
```

**Windows 10/11**, trong PowerShell:

```powershell
git clone <địa chỉ repo> open-agenticos
cd open-agenticos
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

Đã có Node thì cả hai máy đều chạy được `npm run setup`: lệnh này tự chọn `install.sh` hay `install.ps1`.

`-ExecutionPolicy Bypass` chỉ áp cho lần chạy này, để PowerShell chạy được file `install.ps1` chưa ký số trong repo. Nó không đổi cài đặt của máy.

## Trình cài làm gì, theo thứ tự

| Bước | Việc | Lần chạy sau |
|---|---|---|
| 1. Kiểm tra máy | Node (bản trong `engines` của `package.json`, hiện là 22 trở lên), git, còn trống khoảng 3 GB | Kiểm lại |
| 2. Thư viện | `npm ci` cho app. Không cài gì cho `cloud/` hay `mobile/` | Bỏ qua khi `package-lock.json` và bản Node không đổi |
| 3. `.env` | Chép `.env.example` thành `.env` | Không bao giờ ghi đè `.env` đã có |
| 4. GenBot | Tải bản mới nhất từ GitHub, kiểm sha512, rồi cài | Đã có GenBot thì chỉ báo bản đang dùng, không cài lại |
| 5. Khởi động GenBot | Mở GenBot, chờ tối đa 60 giây cho cổng 8799 (phần chạy nền) và 8800 (Bot API) | Đang chạy thì bỏ qua |
| 6. Nối bot | In từng bước cần bấm trong GenBot và Open AgenticOS (xem dưới) | Đã nối đủ thì báo đã nối |
| 7. Chạy app | `npm run dev`, mở liên kết đăng nhập chủ một lần, rồi mở màn **Đội AI · Bot** | App đã chạy thì không chạy bản thứ hai |

Thiếu Node hay git, trình cài in đúng lệnh cài rồi dừng. Nó không tự cài phần mềm hệ thống:

- macOS: `brew install node` (chưa có Homebrew thì tải bản LTS ở https://nodejs.org), `xcode-select --install` cho git.
- Windows: `winget install --id OpenJS.NodeJS.LTS -e`, `winget install --id Git.Git -e`.

Chạy lại trình cài bao nhiêu lần cũng được. Nó bỏ qua việc đã xong, làm nốt việc còn thiếu, và **không xoá** dữ liệu của bạn: thư mục brain, `data/`, `.env`, dữ liệu của GenBot.

### Tuỳ chọn

| Tuỳ chọn | Ý nghĩa |
|---|---|
| `--update-genbot` | Cập nhật GenBot khi có bản mới hơn. Thoát GenBot trước khi chạy |
| `--resume` | Chạy tiếp từ bước 5, sau khi bạn làm xong việc cần bấm trong GenBot |
| `--dry-run` | Chỉ in việc sẽ làm. Không tải, không cài, không ghi file, không mở app |
| `--system` | (macOS) Cho phép dùng `sudo` để chép GenBot vào `/Applications` khi tài khoản của bạn không ghi được ở đó. Không có tuỳ chọn này thì GenBot vào `~/Applications` |
| `--no-open` | Không tự mở trình duyệt, chỉ in liên kết |
| `--no-start` | Cài xong thì dừng, không chạy app |

Truyền qua npm: `npm run setup -- --update-genbot`.

## Cài vào đâu

| Thứ | macOS | Windows |
|---|---|---|
| Open AgenticOS | Thư mục repo bạn đã clone | Thư mục repo bạn đã clone |
| Dữ liệu của app | `data/` và `.env` trong thư mục repo | như macOS |
| GenBot | `/Applications/GenBot.app` (hoặc `~/Applications/GenBot.app`) | `%LOCALAPPDATA%\Programs\GenBot\GenBot.exe` |
| Dữ liệu của GenBot | `~/Library/Application Support/GenBot`, nhật ký ở `~/Library/Logs/GenBot` | `%APPDATA%\GenBot` |

Khi chạy, app nghe ở `127.0.0.1:4380` (API) và `127.0.0.1:5173` (giao diện; cổng này bận thì Vite dùng cổng kế tiếp, xem dòng `Local:` mà `npm run dev` in ra). GenBot nghe ở `127.0.0.1:8799` và `127.0.0.1:8800`. Mọi cổng chỉ mở trên máy này.

## Cách tải GenBot an toàn

- Chỉ tải từ `github.com/Freedombuiders/genbot-releases`, qua HTTPS. Mọi lần chuyển hướng phải về máy chủ của GitHub, không thì dừng.
- Mã kiểm sha512 lấy từ `latest-mac.yml` (macOS) hoặc `latest.yml` (Windows) **của cùng bản phát hành**. File tải về được kiểm sha512 và kích thước **trước khi mở**. Sai thì xoá ngay.
- File nằm trong một thư mục tạm, cài xong (hoặc lỗi) thì xoá.
- macOS: giải nén bằng `ditto`, kiểm chữ ký số (`codesign`), hỏi Gatekeeper (`spctl`). App được gắn nhãn "tải từ Internet" như khi tải bằng trình duyệt, nên lần đầu mở macOS hỏi "GenBot là ứng dụng tải từ Internet…": bấm **Mở**. Trình cài không gỡ nhãn này và không tắt Gatekeeper. GenBot 1.0.4 đã được Apple notarize. Nếu một bản sau chưa notarize, trình cài báo, và bạn mở lần đầu qua **Cài đặt hệ thống › Quyền riêng tư & Bảo mật › Vẫn mở**.
- Windows: file được gắn nhãn "tải từ Internet" như trình duyệt làm, rồi kiểm chữ ký số. Bản cài đã ký thì chạy im lặng (`/S`, không cần quyền quản trị, cài cho riêng tài khoản của bạn). Bản chưa ký thì chạy có cửa sổ, và Windows có thể hiện "Windows đã bảo vệ máy tính": chỉ bấm **Thông tin thêm › Vẫn chạy** nếu bạn tin nguồn trên. Trình cài không tắt SmartScreen.
- Không chạy `curl | sh`, không sửa `.zshrc`, `.bashrc` hay hồ sơ PowerShell, không đổi biến môi trường của máy.

## Việc bạn phải bấm trong GenBot

Trình cài **không** tạo bot hay cấp khoá Bot API thay bạn được. Bản desktop của GenBot chỉ nhận thay đổi từ chính cửa sổ của nó: mọi yêu cầu tạo, sửa hay cấp khoá đến từ chương trình khác trên máy đều bị từ chối (403), và GenBot tắt việc ghép thiết bị. Đây là một lớp an toàn của GenBot. Vì thế trình cài chỉ hỏi GenBot `GET /api/health` để biết nó đã chạy, rồi in các bước sau:

1. Lần đầu mở GenBot: đăng nhập tài khoản GenBot (GenBot mở trang app.genbot.io), và chọn AI cho bot (Claude, Codex hoặc khoá API của nhà cung cấp AI). Xong thì chạy `npm run setup -- --resume`.
2. Trong GenBot, bấm **Bot mới** ba lần để tạo **Bot CSKH**, **Bot Nội dung**, **Bot Trợ lý**. Chọn AI chạy được ở chế độ nhốt (Claude, Codex hoặc AI dùng khoá API).
3. Mở một bot, bấm bánh răng **Cài đặt › Nâng cao › Quyền truy cập › Bot API**, bật **Cho ứng dụng trò chuyện với bot này**.
4. Thẻ Bot API hiện một lệnh mẫu có khoá. Bấm **Sao chép** ngay: khoá chỉ hiện một lần (mất thì bấm **Khóa mới**). Mã bot là phần nằm giữa `/hooks/api/bots/` và `/messages`.
5. Trong Open AgenticOS (trình cài tự mở), vào **Đội AI · Bot**, bấm **Thêm bot GenBot**, chọn mẫu, điền **Mã bot GenBot**, dán khoá, bấm **Kiểm tra rồi lưu**. Bot đã có thẻ thì bấm **Sửa** và **Đổi khoá**.
6. Lặp lại bước 3 đến 5 cho hai bot còn lại.

Khoá chỉ dán vào Open AgenticOS. App lưu khoá mã hoá trong `data/aios.db` và chỉ hiện 4 ký tự cuối. Đừng dán khoá vào `.env` hay `agent.yaml`. Chi tiết và bảng lỗi: [docs/huong-dan-noi-genbot.md](docs/huong-dan-noi-genbot.md).

## Đăng nhập chủ

Khi app chạy, terminal in một liên kết dùng một lần (`http://127.0.0.1:4380/api/owner/pair?code=…`). Trình cài mở liên kết đó qua cổng giao diện, nên bạn vào thẳng app với quyền chủ. Dùng `127.0.0.1`, không dùng `localhost`: cookie của chủ gắn với `127.0.0.1`. Mở bằng `localhost` thì nhập mã ở màn **Đăng nhập chủ**. Xem [docs/dev/OWNER-AUTH.md](docs/dev/OWNER-AUTH.md).

## Kiểm tra máy

```bash
npm run doctor            # hoặc: npm run aios -- doctor
npm run doctor -- --probe # gửi "ping" thật tới từng bot (cần AIOS_TOKEN trong .env)
```

Mỗi mục một dòng, kèm cách sửa: Node, các cổng 4380, 5173, 8799, 8800, GenBot đã cài (bản nào) và đang chạy, Bot API trả lời, từng bot GenBot có mã bot và khoá (và trả lời "ping" khi thêm `--probe`), yt-dlp và ffmpeg (chỉ cần cho Dream 100), git trong từng thư mục brain. Doctor chỉ đọc. `--probe` tính vào 10 lượt mỗi phút của mỗi bot.

## Cập nhật

- Open AgenticOS: `git pull`, rồi `npm run setup` (cài lại thư viện khi `package-lock.json` đổi).
- GenBot: thoát GenBot, rồi `npm run setup -- --update-genbot`. Bản cũ được giữ làm dự phòng cho tới khi bản mới vào chỗ. Dữ liệu và bot của GenBot không bị đụng tới. GenBot cũng tự báo khi có bản mới.

## Gỡ cài đặt

Dữ liệu của bạn chỉ mất khi bạn tự xoá. Làm theo thứ tự:

1. Dừng app (Ctrl-C ở terminal đang chạy `npm run dev`). Thoát GenBot.
2. Open AgenticOS: xoá thư mục repo. Muốn giữ dữ liệu thì chép `data/`, `.env` (có khoá mã hoá, mất khoá thì không đọc lại được dữ liệu đã mã hoá) và các thư mục brain ra chỗ khác trước.
3. GenBot trên macOS: kéo `GenBot.app` từ Ứng dụng vào Thùng rác. Dữ liệu ở `~/Library/Application Support/GenBot`.
4. GenBot trên Windows: **Cài đặt › Ứng dụng › GenBot › Gỡ cài đặt**. Dữ liệu ở `%APPDATA%\GenBot`.

## Gửi gì ra mạng

| Đi đâu | Khi nào | Gửi gì |
|---|---|---|
| `registry.npmjs.org` | Bước 2 (`npm ci`) | Tên và bản các thư viện trong `package-lock.json` |
| `api.github.com`, `github.com` và máy chủ tải file của GitHub | Bước 4, chỉ khi chưa có GenBot hoặc khi có `--update-genbot` | Yêu cầu đọc bản phát hành công khai và tải file. Không gửi token, tên hay dữ liệu của bạn |
| app.genbot.io | Khi bạn đăng nhập GenBot | Do GenBot làm, trong cửa sổ của GenBot |
| Nhà cung cấp AI (Anthropic, OpenAI…) | Khi bot trả lời | Do GenBot gửi, theo AI bạn chọn cho từng bot. Open AgenticOS gửi ngữ cảnh mỗi lượt tới GenBot trên máy này (127.0.0.1:8800), không gửi thẳng ra ngoài |

Trình cài không gửi khoá, mã ghép hay dữ liệu nào của bạn ra ngoài.

## Giới hạn

- GenBot chỉ có bản cho **Mac Apple Silicon** và **Windows x64**. Mac chip Intel và Linux: trình cài vẫn cài Open AgenticOS, báo rằng máy không có GenBot, và gợi ý chạy GenBot trên một máy được hỗ trợ trong cùng mạng rồi điền địa chỉ `https://` của nó ở **Đội AI · Bot**. Windows ARM chạy bản x64 qua giả lập.
- Chưa có cách tạo bot và cấp khoá GenBot mà không bấm trong GenBot (xem trên).
- `--probe` của doctor cần `AIOS_TOKEN`, vì kiểm bot là việc của chủ.
- Trình cài cài bản dev (`npm run dev`). Chạy bản build một cổng: `npm run build && npm start`.

## Khi có lỗi

| Thông báo | Cách xử lý |
|---|---|
| GitHub tạm chặn vì hỏi quá nhiều lần | Chờ tới giờ trình cài nói rồi chạy lại, hoặc tải GenBot tay ở github.com/Freedombuiders/genbot-releases/releases/latest, cài xong chạy lại `npm run setup` |
| Không khớp sha512 | File đã bị xoá, không mở. Chạy lại. Vẫn lỗi thì báo người phát hành GenBot |
| Phần chạy nền của GenBot dừng ngay khi khởi động | Lỗi bên trong GenBot. Trình cài in câu lỗi và đường dẫn nhật ký, không sửa dữ liệu của GenBot. Thoát hẳn GenBot rồi mở lại; vẫn lỗi thì gửi nhật ký cho https://genbot.io/ho-tro |
| GenBot chưa trả lời sau 60 giây | Thường là GenBot đang chờ bạn đăng nhập hoặc chọn AI lần đầu. Làm xong rồi `npm run setup -- --resume` |
| Cổng 4380 bị chương trình khác giữ | Tắt chương trình đó, hoặc đặt `AIOS_PORT` khác trong `.env` |
