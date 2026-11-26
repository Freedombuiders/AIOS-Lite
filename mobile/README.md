# Open AgenticOS: app điện thoại

App Expo (React Native) đi kèm bản máy tính (giả định G4). Bản này **chỉ nói chuyện với cloud** (`../cloud`): đăng nhập Google, xem kho dữ liệu, cài đặt tài khoản. Ghép điện thoại với máy ở nhà, tab "Cần bạn" và "Hộp thư", thông báo đẩy, giọng nói **chưa có** (hai tab đầu hiện trạng thái "Sắp có"). Nút "Cài xuống máy tính" ở chi tiết gói bị khoá và ghi rõ "sắp có". Điện thoại **không bao giờ tải file gói**.

| | |
|---|---|
| Expo SDK | 58 (`expo@~58.0.26`, bản `latest` trên npm lúc làm, 26/11/2026), React Native 0.88, React 19.3 |
| Điều hướng | `expo-router` (route trong `app/`, bảo vệ bằng `Stack.Protected`) |
| Đăng nhập | `@react-native-google-signin/google-signin` 17 (cần development build) |
| Lưu mã | `expo-secure-store` (Keychain / Keystore), chỉ giữ trong bộ nhớ khi chạy |
| Dữ liệu | `fetch` bọc trong `src/api/cloud.ts`, bộ nhớ đệm TanStack Query (chỉ trong bộ nhớ) |
| Kiểu API | `../packages/api-types` (chỉ có kiểu), dùng chung với `cloud/` |
| Giao diện | tối, màu theo `web/src/styles/main.css` (khối `@theme`), phông Be Vietnam Pro đóng gói sẵn |
| Ngôn ngữ | Tiếng Việt mặc định, có English (`src/i18n`) |

## Chạy

```sh
cd mobile
npm install
npm run typecheck      # tsc --noEmit
npm test               # jest (jest-expo, không gọi mạng)
npm run doctor         # expo-doctor
```

### Với cloud chạy cục bộ

```sh
# cửa sổ 1: cloud (xem cloud/README.md)
cd cloud && npm run db:migrate:local && npm run dev      # http://localhost:8787, DEV_MODE=1

# cửa sổ 2: app
cd mobile
EXPO_PUBLIC_CLOUD_URL=http://localhost:8787 EXPO_PUBLIC_DEV_SIGNIN=1 npx expo start
```

- Trên **trình giả lập iOS** dùng `http://localhost:8787`. Trên **trình giả lập Android** dùng `http://10.0.2.2:8787`. Trên **điện thoại thật** dùng địa chỉ IP máy tính trong mạng LAN hoặc một cloud đã dựng.
- `EXPO_PUBLIC_DEV_SIGNIN=1` chỉ có tác dụng trong bản dev (`__DEV__`): hiện nút "Đăng nhập thử" gọi `POST /auth/dev`. Cloud chỉ trả lời đường này khi `DEV_MODE=1` **và** request tới `localhost`/`127.0.0.1`, nên nút này không dùng được với cloud thật. Bản release không bao giờ hiện nút.
- Muốn có gói để xem: phát hành gói mẫu theo `cloud/README.md` mục "Phát hành một gói".
- Đường web (`npx expo start --web`) chỉ để kiểm nhanh giao diện. Cloud không gửi header CORS (và task này không thêm đường hay header vào cloud), nên trình duyệt chỉ gọi được qua một proxy thêm CORS ở giữa. Trên iOS/Android không cần. Trên web, Google sign-in không có (nút báo cần development build) và mã chỉ giữ trong bộ nhớ.

## Đăng nhập Google: client id nào đặt ở đâu

Cloud (`cloud/src/auth/google.ts`) kiểm ID token: chữ ký với khoá của Google, `iss` là Google, `exp` còn hạn, `email_verified` đúng, và **`aud` phải nằm trong `GOOGLE_CLIENT_IDS`**. Client id web (`GOOGLE_WEB_CLIENT_ID`) tự được thêm vào danh sách đó (`cloud/src/config.ts`).

Tạo trong Google Cloud Console › APIs & Services › Credentials, **cùng một dự án** với client web của cloud:

| Loại client | Cần | Đặt ở đâu |
|---|---|---|
| **Web application** | (đã có cho cloud) | App: `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` (bắt buộc, thư viện không cấp ID token nếu thiếu). Cloud: `GOOGLE_WEB_CLIENT_ID`. Không đưa **secret** của client này vào app, nó chỉ ở Worker. |
| **iOS** | Bundle ID đúng với `ios.bundleIdentifier` trong `app.config.ts` | App: `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`, lúc build. `app.config.ts` tự suy ra URL scheme đảo ngược (`com.googleusercontent.apps.<id>`) mà SDK Google iOS cần. Cloud: thêm vào `GOOGLE_CLIENT_IDS`. |
| **Android** | Package name đúng với `android.package` và **SHA-1** của từng chứng chỉ ký: khoá debug, khoá EAS (`eas credentials`), và khoá "App signing" của Play Console | Không đặt gì trong code app: Android ghép client theo package + SHA-1. Cloud: thêm vào `GOOGLE_CLIENT_IDS`. |

Ví dụ `GOOGLE_CLIENT_IDS` ở cloud: `<id iOS>.apps.googleusercontent.com,<id Android>.apps.googleusercontent.com` (web tự thêm).

Điều cần kiểm lần đầu trên máy thật, vì code ở đây chưa chạy được trên máy thật: với `webClientId` đã cấu hình, ID token thường mang `aud` = client web ở cả hai nền tảng (client iOS/Android chỉ dùng để Google nhận ra app). Nếu cloud trả 401 "ID token Google không hợp lệ" dù đăng nhập Google xong, giải mã **một** token thử (đừng ghi vào log hay commit), xem `aud`, rồi đưa đúng giá trị đó vào `GOOGLE_CLIENT_IDS`. Thêm cả ba client id vào danh sách là vô hại.

Package name và bundle ID trong `app.config.ts` (`app.agenticos.mobile`) là **chỗ giữ chỗ**: chốt tên thật **trước** khi tạo client Google và EAS project, vì client iOS/Android gắn với chúng.

Không có client secret nào trong app, và `EXPO_PUBLIC_*` bị nhúng vào bản build nên **không bao giờ** đặt bí mật vào đó. Các client id là giá trị công khai.

## Development build

Google sign-in là mã native nên **không chạy trong Expo Go**. Cần bản dựng riêng có `expo-dev-client`:

```sh
npx expo run:ios       # hoặc run:android, build cục bộ, cần Xcode / Android Studio
# hoặc dùng EAS (cần tài khoản Expo): eas build --profile development --platform ios
```

`eas.json` có sẵn profile `development`, `preview`, `production`. Chưa có EAS project nào được tạo và chưa build gì trên EAS (xem "Việc người phải làm").

## Cách app hoạt động

- **Mã phiên**: `POST /auth/google` với `{ idToken, kind: "mobile" }` đổi ID token lấy mã phiên (90 ngày). Mã chỉ nằm trong `expo-secure-store` và bộ nhớ, không nằm trong state React, query key, URL hay log. App không có analytics hay SDK báo lỗi.
- **401** trên một lệnh có mang mã (hết hạn, bị thu hồi, hoặc tài khoản bị khoá: cloud trả 401 cho phiên của người bị khoá) → xoá mã, về màn đăng nhập kèm thông báo "phiên đã hết hạn", rồi sau khi đăng nhập lại thì quay về màn đang xem.
- **403 khi đăng nhập** = tài khoản bị khoá, hiện "Tài khoản này đã bị khoá. Hãy liên hệ quản trị viên."
- **Mạng**: mọi lệnh có thời hạn 15 giây; mất mạng hoặc quá hạn hiện câu rõ ràng kèm nút "Thử lại", không quay vòng mãi. Mọi màn có trạng thái đang tải, rỗng và lỗi.
- **Cài đặt**: thông tin tài khoản, đổi ngôn ngữ, danh sách phiên (`GET /me`) và thu hồi phiên khác (`DELETE /me/sessions/:id`), đăng xuất (`POST /auth/logout`), xoá tài khoản (`DELETE /me`) sau một hộp thoại xác nhận.
- **Kho dữ liệu**: `GET /packs?module=&q=`, `GET /packs/:id`. Không gọi `…/download`.
- **Thêm nhà cung cấp đăng nhập thứ hai** (ví dụ Apple): xem đầu `src/auth/providers/types.ts`. Thêm một loại credential, một file provider cạnh `google.ts`, một nhánh trong `AuthStore.exchange` (và đường tương ứng ở cloud), rồi liệt kê trong `providers/index.ts`; màn đăng nhập tự vẽ nút.

## Quy định của Apple: chủ dự án phải kiểm

Apple có điều kiện riêng cho app chỉ cung cấp đăng nhập bên thứ ba (hiện ở App Store Review Guidelines, mục Sign in with Apple). **Không dựa vào trí nhớ hay vào ghi chú này**: trước khi nộp lên App Store, đọc bản hướng dẫn hiện hành và quyết định có cần thêm "Đăng nhập với Apple" hay một cách đăng nhập tương đương không. Nếu cần, đó là một task riêng (cloud phải nhận thêm loại token). Mã đăng nhập đã chia sẵn theo nhà cung cấp để thêm được.

## Cấu trúc

```
app/                        route (expo-router)
  _layout.tsx               cổng đăng nhập, tải phông, bộ nhớ đệm
  (auth)/sign-in.tsx
  (tabs)/{index,inbox}.tsx  "Cần bạn", "Hộp thư": trạng thái "Sắp có"
  (tabs)/store.tsx          kho dữ liệu
  (tabs)/settings.tsx
  store/[id].tsx            chi tiết gói
  __tests__/                test thành phần (API giả)
src/api/                    cloud.ts (client có kiểu), errors.ts
src/auth/                   AuthStore, providers/, kho mã an toàn
src/components, src/theme, src/i18n, src/lib, src/test
```

## Test

`npm test` chạy jest-expo. Không có test nào gọi mạng hay Keychain: client nhận `fetch` truyền vào, kho mã được truyền vào, `globalThis.fetch` ném lỗi nếu quên.

- `src/api/cloud.test.ts`: 401 → gọi hook đăng xuất (và không gọi khi đang đăng nhập), 403 → tài khoản khoá, lỗi mạng → `network`, quá hạn → `timeout`, 5xx, 404, 429, thân trả về lạ, mã không lọt vào lỗi.
- `src/auth/store.test.ts`: luồng đăng nhập, 401 xoá mã, quay lại màn cũ, đăng xuất, xoá tài khoản.
- `app/__tests__/{store,pack,settings}.test.tsx`: màn kho, chi tiết gói, cài đặt, với API giả: đang tải, rỗng, lỗi mạng, thử lại, tiếng Anh, cỡ vùng chạm, nhãn nút chỉ có biểu tượng.
- `src/theme/theme.test.ts`: độ tương phản của các cặp màu dùng trong màn hình.

Chưa có luồng Maestro (`.maestro/`) và chưa có test chạy trên máy/giả lập thật.

## Việc người phải làm trước khi chạy trên điện thoại thật

1. Chốt bundle ID / package name (đang là giữ chỗ).
2. Tạo client Google (web, iOS, Android) như bảng trên, lấy SHA-1 cho Android; đặt `GOOGLE_CLIENT_IDS`, `GOOGLE_WEB_CLIENT_ID` (+ secret bằng `wrangler secret put`) ở cloud.
3. Dựng cloud thật (D1, R2, khoá ký gói: `cloud/README.md`) và đặt `EXPO_PUBLIC_CLOUD_URL` (HTTPS) lúc build.
4. Chạy development build trên máy thật (cần Xcode / Android SDK, hoặc tài khoản Expo cho EAS), đăng nhập, kiểm `aud` như trên.
5. Trước khi nộp cửa hàng: kiểm quy định đăng nhập của Apple, chuẩn bị chính sách riêng tư, biểu tượng và ảnh chụp thật (`assets/images/*` hiện là ảnh giữ chỗ).
