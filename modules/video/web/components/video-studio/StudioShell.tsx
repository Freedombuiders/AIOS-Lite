// Three-column Video Studio: profiles + jobs | chat | ticket / library / preview.
import { useEffect, useRef, useState } from 'preact/hooks';
import { Upload, X } from 'lucide-preact';
import { Drawer } from './Drawer';
import {
  bootstrap, closeEditor, editorOpen, leftDrawerOpen, libraryModal, messages, openProjectStream, project,
  projectLoading, restoreEditorFromUrl, rightOpen, selectedProjectId, uploadFile, useStudioLayout, type StudioLayout,
} from '@modules/video/web/lib/video-edit/studio';
import { BriefForm } from './BriefForm';
import { EditorView } from './EditorView';
import { LibraryManager } from './library/LibraryManager';
import { CenterHeader } from './CenterHeader';
import { ChatThread } from './ChatThread';
import { Composer } from './Composer';
import { DoctorModal } from './DoctorModal';
import { EmptyState } from './EmptyState';
import { ProfileModal } from './ProfileModal';
import { ProfileSidebar } from './ProfileSidebar';
import { RightPanel } from './RightPanel';
import { StylePickerModal } from './StylePickerModal';
import { VoiceModal } from './VoiceModal';
import '@modules/video/web/styles/video-studio.css';

function hasFiles(e: DragEvent) {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files');
}

export function StudioShell() {
  const rootRef = useRef<HTMLDivElement>(null);
  const layout = useStudioLayout(rootRef);
  const prevLayout = useRef<StudioLayout | null>(null);
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);

  useEffect(() => {
    void bootstrap().then(() => restoreEditorFromUrl());
    const onPop = () => { void restoreEditorFromUrl(); };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const projectId = selectedProjectId.value;
  useEffect(() => (projectId ? openProjectStream(projectId) : undefined), [projectId]);

  // Right panel: a column on wide screens, a sheet (closed by default) otherwise.
  useEffect(() => {
    const prev = prevLayout.current;
    if (prev === null || (layout === 'wide') !== (prev === 'wide')) rightOpen.value = layout === 'wide';
    if (layout !== 'narrow') leftDrawerOpen.value = false;
    prevLayout.current = layout;
  }, [layout]);

  const sheetOpen = layout !== 'wide' && rightOpen.value;
  useEffect(() => {
    if (!sheetOpen) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('[role="dialog"][aria-modal="true"]')) rightOpen.value = false;
    };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [sheetOpen]);

  const p = project.value;
  const inEditor = editorOpen.value && !!p?.plan;
  // A project without a plan has nothing to edit: leave the editor view (and its URL) behind.
  useEffect(() => {
    if (editorOpen.value && p && !p.plan && !projectLoading.value) closeEditor('replace');
  }, [p?.id, !!p?.plan, projectLoading.value]);
  const loading = !!projectId && !p && projectLoading.value;
  const showEmpty = !loading && (!p || (messages.value.length === 0 && !p.source));

  if (inEditor) {
    return (
      <div class="vs-root" ref={rootRef}>
        <section class="vs-center" aria-label="Màn chỉnh sửa video"><EditorView /></section>
        <ModalLayer />
      </div>
    );
  }

  return (
    <div class="vs-root" ref={rootRef}>
      {layout !== 'narrow' && <div class="vs-left"><ProfileSidebar /></div>}
      {layout === 'narrow' && (
        <Drawer open={leftDrawerOpen.value} onClose={() => { leftDrawerOpen.value = false; }} title="Hồ sơ thương hiệu và việc dựng">
          <ProfileSidebar onNavigate={() => { leftDrawerOpen.value = false; }} />
        </Drawer>
      )}

      <section
        class="vs-center"
        aria-label="Trò chuyện với agent dựng video"
        onDragEnter={(e) => { if (hasFiles(e)) { e.preventDefault(); depth.current++; setDragging(true); } }}
        onDragOver={(e) => { if (hasFiles(e)) { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; } }}
        onDragLeave={() => { depth.current = Math.max(0, depth.current - 1); if (depth.current === 0) setDragging(false); }}
        onDrop={(e) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          depth.current = 0;
          setDragging(false);
          const file = Array.from(e.dataTransfer?.files ?? [])[0];
          if (file) void uploadFile(file);
        }}
      >
        <CenterHeader layout={layout} />
        {loading && <div class="vs-loading" role="status">Đang mở việc…</div>}
        {showEmpty && <EmptyState />}
        {!loading && !showEmpty && (
          <>
            <ChatThread />
            <div class="vs-dock"><Composer variant="dock" /></div>
          </>
        )}
        {dragging && (
          <div class="vs-drop" aria-hidden="true">
            <Upload size={30} />
            <span>Thả video quay thô vào đây</span>
          </div>
        )}
      </section>

      {layout === 'wide' && rightOpen.value && <div class="vs-right-col"><RightPanel /></div>}
      {sheetOpen && (
        <>
          <div class="vs-sheet-backdrop" onClick={() => { rightOpen.value = false; }} />
          <div class="vs-sheet" role="dialog" aria-label="Bảng điều khiển">
            <button type="button" class="vs-icon-btn vs-sheet-close" aria-label="Đóng bảng bên phải" onClick={() => { rightOpen.value = false; }}>
              <X size={16} aria-hidden="true" />
            </button>
            <RightPanel />
          </div>
        </>
      )}

      <ModalLayer />
    </div>
  );
}

function ModalLayer() {
  return (
    <>
      <StylePickerModal />
      <ProfileModal />
      <VoiceModal />
      <DoctorModal />
      <BriefForm />
      <LibraryManager open={libraryModal.value} onClose={() => { libraryModal.value = false; }} />
    </>
  );
}
