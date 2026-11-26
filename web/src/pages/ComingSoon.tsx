// Placeholder for a menu entry whose screen is not built yet. Says so plainly and points to what exists today.
import { Construction } from 'lucide-preact';
import { Link } from 'wouter-preact';
import { PageHeader } from '@/components/PageHeader';

export interface ComingSoonProps {
  title: string;
  /** one line on what the page will do */
  about: string;
  /** where to go meanwhile */
  alt?: { label: string; href: string };
}

export function ComingSoon({ title, about, alt }: ComingSoonProps) {
  return (
    <div class="page">
      <PageHeader title={title} />
      <section class="card card-pad coming-soon" aria-labelledby="coming-soon-h">
        <Construction size={22} aria-hidden="true" />
        <h2 id="coming-soon-h" class="m-0 text-[14px] font-semibold">Chưa làm</h2>
        <p class="m-0 text-[13px] text-[var(--color-text-muted)]">{about}</p>
        {alt && <Link href={alt.href} class="control-button no-underline">{alt.label}</Link>}
      </section>
    </div>
  );
}

export function VoicePlaceholder() {
  return <ComingSoon title="Gọi trợ lý" about="Nói chuyện trực tiếp với trợ lý bằng giọng nói. Tính năng này chưa có; hiện bạn nhắn chữ ở trang Trò chuyện hoặc ở thanh ra lệnh phía dưới." alt={{ label: 'Mở Trò chuyện', href: '/chat' }} />;
}

export function GraphPlaceholder() {
  return <ComingSoon title="Đồ thị" about="Bản đồ các ghi chú trong brain và liên kết giữa chúng. Màn này chưa có; hiện bạn xem và tìm ghi chú ở trang Second Brain." alt={{ label: 'Mở Second Brain', href: '/brain' }} />;
}
