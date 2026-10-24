// "Kiểm tra máy": ffmpeg, whisper, HyperFrames… with fix hints.
import { CheckCircle2, RefreshCw, XCircle } from 'lucide-preact';
import { Modal } from '@/components/Modal';
import { doctor, doctorLoading, doctorModal, refreshDoctor } from '@modules/video/web/lib/video-edit/studio';

export function DoctorModal() {
  if (!doctorModal.value) return null;
  const d = doctor.value;
  const close = () => { doctorModal.value = false; };
  return (
    <Modal
      open
      onClose={close}
      title="Kiểm tra máy"
      width={620}
      footer={
        <>
          <button type="button" class="vs-btn" disabled={doctorLoading.value} onClick={() => void refreshDoctor()}>
            <RefreshCw size={14} class={doctorLoading.value ? 'vs-spin' : ''} aria-hidden="true" /> Kiểm tra lại
          </button>
          <button type="button" class="vs-btn ml-auto" onClick={close}>Đóng</button>
        </>
      }
    >
      {d && (
        <p class="vs-muted vs-doctor-sum" role="status">
          Ổn {d.ok}/{d.total} mục. {d.requiredOk ? 'Các mục bắt buộc đều đạt.' : 'Còn mục bắt buộc chưa đạt, một số bước sẽ không chạy được.'}
        </p>
      )}
      {!d && <p class="vs-muted" role="status">{doctorLoading.value ? 'Đang kiểm tra…' : 'Chưa có kết quả.'}</p>}
      <ul class="vs-doctor">
        {d?.checks.map((c) => (
          <li key={c.id} class={c.ok ? 'is-ok' : 'is-fail'}>
            <span class="vs-doctor-icon">{c.ok ? <CheckCircle2 size={18} aria-label="Đạt" /> : <XCircle size={18} aria-label="Chưa đạt" />}</span>
            <div class="vs-doctor-main">
              <div class="vs-doctor-top">
                <span class="vs-doctor-label">{c.label}</span>
                <span class={`vs-badge ${c.required ? 'vs-badge-req' : ''}`}>{c.required ? 'Bắt buộc' : 'Tuỳ chọn'}</span>
              </div>
              <div class="vs-muted vs-doctor-detail">{c.detail}</div>
              {!c.ok && c.fix && <div class="vs-doctor-fix"><b>Cách sửa:</b> {c.fix}</div>}
            </div>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
