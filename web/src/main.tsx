import { render } from 'preact';
import { App } from './App';
import { mockEnabled } from './lib/mock';
import { installOwnerFetchGuard } from './lib/owner';
import './styles/main.css';
import './styles/workspace.css';
import './styles/home-dashboard.css';
import './styles/agents.css';
import './styles/chat-v2.css';
import './styles/second-brain.css';
import './styles/sidebar-nav.css';
import './styles/memory.css';
import './styles/command-bar.css';

// owner refusals (x-aios-owner) from any page or module open the sign-in screen; ?mock=1 never calls the server
if (!mockEnabled()) installOwnerFetchGuard();

render(<App />, document.getElementById('app')!);
