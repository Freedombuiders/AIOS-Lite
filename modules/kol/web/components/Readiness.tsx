// Non-blocking banners that name the next step when the studio cannot run.

import { Link } from 'wouter-preact';
import { SetupNotice } from '@modules/kol/web/components/shared/common';
import type { KolStatusDto } from '@modules/kol/web/lib/kol';

const LINK = 'text-[var(--color-accent)] underline';

/** Generation readiness: kill switch, master switch, provider keys. */
export function StudioReadiness({ status }: { status: KolStatusDto | null }) {
  if (!status) return null;
  if (!status.killSwitches.generate) {
    return (
      <SetupNotice title="Tạo ảnh đang bị khoá">
        Công tắc “Cho phép tạo ảnh/video” của module KOL Studio đang tắt nên mọi lần tạo ảnh/video bị từ chối. Bật lại ở Modules › KOL Studio › Cài đặt.
      </SetupNotice>
    );
  }
  if (!status.enabled) {
    return (
      <SetupNotice title="KOL Studio đang tắt">
        Bạn vẫn xem và soạn được, nhưng không tạo ảnh mới. Bật ở <Link href="/m/kol?tab=settings" class={LINK}>KOL Studio › Cài đặt</Link>.
      </SetupNotice>
    );
  }
  if (!status.providers.some((p) => p.configured)) {
    return (
      <SetupNotice title="Chưa có nhà cung cấp AI nào">
        Cần một nguồn tạo ảnh: đăng nhập Codex bằng tài khoản ChatGPT (<code>codex login</code>), hoặc một API key Gemini (<code>GOOGLE_API_KEY</code>), fal.ai, Higgsfield ở <Link href="/connections" class={LINK}>Kết nối</Link>.
      </SetupNotice>
    );
  }
  return null;
}

/** Publishing readiness: kill switch, Composio. publishEnabled lives in settings, shown where it matters. */
export function PublishReadiness({ status, publishEnabled }: { status: KolStatusDto | null; publishEnabled?: boolean }) {
  if (!status) return null;
  if (!status.killSwitches.publish) {
    return (
      <SetupNotice title="Đăng bài đang bị khoá">
        Công tắc an toàn <code>KOL_PUBLISH_ENABLED</code> đang tắt. Bài vẫn được lên lịch nhưng sẽ không đăng cho tới khi bật lại.
      </SetupNotice>
    );
  }
  if (!status.composio) {
    return (
      <SetupNotice title="Chưa kết nối Composio">
        KOL Studio đăng lên Facebook, Instagram, TikTok, YouTube qua Composio. Nhập API key ở <Link href="/connections" class={LINK}>Kết nối › Composio</Link>.
      </SetupNotice>
    );
  }
  if (publishEnabled === false) {
    return (
      <SetupNotice title="Tự động đăng đang tắt">
        Bài đã lên lịch sẽ chờ, chưa đăng thật. Bật “Cho phép đăng bài” ở <Link href="/m/kol?tab=settings" class={LINK}>KOL Studio › Cài đặt</Link> khi bạn sẵn sàng.
      </SetupNotice>
    );
  }
  return null;
}
