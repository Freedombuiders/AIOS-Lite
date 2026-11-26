import { Telescope } from 'lucide-preact';
import { defineWebModule, type WebNavItem } from '@/module-host/contracts';
import { ChannelsPage } from './ChannelsPage';
import { VideosPage } from './VideosPage';

// lucide's icon props accept string sizes, the host contract only numbers: cast once here
const icon = Telescope as unknown as WebNavItem['icon'];

export default defineWebModule({
  id: 'dream',
  nav: [{ group: 'marketing', label: 'Dream 100', path: '/m/dream', icon, match: ['/m/dream/videos'] }],
  routes: [
    { path: '/m/dream/videos', component: VideosPage },
    { path: '/m/dream', component: ChannelsPage },
  ],
});
