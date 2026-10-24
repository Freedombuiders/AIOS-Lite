import { render } from 'preact';
import { App } from './App';
import './styles/main.css';
import './styles/workspace.css';
import './styles/home-dashboard.css';
import './styles/agents.css';
import './styles/chat-v2.css';
import './styles/second-brain.css';
import './styles/sidebar-nav.css';
import './styles/memory.css';

render(<App />, document.getElementById('app')!);
