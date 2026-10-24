// Empty center column: no project yet, or a project with neither messages nor a source video.
import { ImageIcon, Link2, ListChecks, Upload } from 'lucide-preact';
import { useState } from 'preact/hooks';
import { Composer } from './Composer';
import { TemplateStart } from './TemplateStart';
import {
  composerFocusNonce, currentProfile, draftText, openFilePickerNonce, profileModal,
} from '@modules/video/web/lib/video-edit/studio';

export function EmptyState() {
  const [inTemplateForm, setInTemplateForm] = useState(false);
  const profile = currentProfile();
  const openProfile = (tab: 'channels' | 'questions') => {
    profileModal.value = { mode: profile ? 'edit' : 'create', tab };
  };
  return (
    <div class="vs-empty vs-empty-templates">
      <div class="vs-empty-inner">
        {!inTemplateForm && <section id="vs-direct-chat" class="vs-template-chat-entry" aria-label="Chat trực tiếp với agent">
          <span class="vs-eyebrow">BẮT ĐẦU VIDEO MỚI</span>
          <h2>Chat với agent dựng video</h2>
          <p>{profile ? `Đang dùng hồ sơ thương hiệu ${profile.name}. ` : ''}Thả video vào ô chat và nói bạn muốn dựng thế nào; agent sẽ hỏi tiếp và lập kế hoạch để bạn duyệt.</p>
          <Composer variant="hero" />
        </section>}
        {!inTemplateForm && <div class="vs-quick">
          <button type="button" class="vs-quick-btn" onClick={() => { openFilePickerNonce.value++; }}>
            <Upload size={14} aria-hidden="true" /> Dựng video quay thô
          </button>
          <button
            type="button"
            class="vs-quick-btn"
            onClick={() => {
              draftText.value = 'Học cách dựng từ video này (chỉ học nhịp cắt, kiểu chữ, màu; không lấy nội dung): ';
              composerFocusNonce.value++;
              openProfile('channels');
            }}
          >
            <Link2 size={14} aria-hidden="true" /> Học từ video TikTok / Facebook
          </button>
          <button
            type="button"
            class="vs-quick-btn"
            onClick={() => {
              draftText.value = 'Làm 3 ảnh bìa cho video này: chữ lớn, dễ đọc, nằm trong vùng an toàn.';
              composerFocusNonce.value++;
            }}
          >
            <ImageIcon size={14} aria-hidden="true" /> Làm ảnh bìa
          </button>
          <button type="button" class="vs-quick-btn" onClick={() => openProfile('questions')}>
            <ListChecks size={14} aria-hidden="true" /> Hoàn thiện hồ sơ thương hiệu (6 câu hỏi)
          </button>
        </div>}
        <TemplateStart onFormChange={setInTemplateForm} />
      </div>
    </div>
  );
}
