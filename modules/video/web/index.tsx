import { Clapperboard } from 'lucide-preact';
import { defineWebModule } from '@/module-host/contracts';
import { VideoStudio } from './pages/VideoStudio';
import './styles/video-studio.css';
import './styles/video-production.css';
import './styles/video-library.css';

export default defineWebModule({
  id: 'video',
  nav: [{ group: 'studio', label: 'AI Video Studio', path: '/m/video', icon: Clapperboard }],
  routes: [{ path: '/m/video', component: VideoStudio }],
  agentAccess: [
    { scope: 'studio.read', label: 'Xem việc dựng và tiến độ video' },
    { scope: 'studio.write', label: 'Tạo video và điều khiển đạo diễn AI', description: 'Chi phí (Veo, fal, HeyGen, Flow) vẫn chờ chủ duyệt.' },
  ],
});
