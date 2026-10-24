import { Modal } from './Modal';

export interface ConfirmModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  loading?: boolean;
  detail?: string;
}

export function ConfirmModal({ open, onClose, onConfirm, title, body, confirmLabel = 'Xác nhận', cancelLabel = 'Huỷ', destructive = false, loading = false, detail }: ConfirmModalProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      width={420}
      closeDisabled={loading}
      footer={
        <>
          <button type="button" class="control-button" disabled={loading} onClick={onClose}>
            {cancelLabel}
          </button>
          <button type="button" class={`control-button ${destructive ? 'control-danger' : 'control-accent'}`} disabled={loading} onClick={onConfirm}>
            {loading ? 'Đang xử lý…' : confirmLabel}
          </button>
        </>
      }
    >
      {body && <p class="m-0 text-[13px]">{body}</p>}
      {detail && <p class="hint mt-2 mb-0">{detail}</p>}
    </Modal>
  );
}
