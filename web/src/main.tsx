import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import '@fontsource-variable/inter';
import '@fontsource-variable/fraunces';
import '@fontsource-variable/jetbrains-mono';
import './theme.css';
import './motion.css';
import './app.css';
import './onboarding.css';
import './redesign.css';
import './dark-v3.css';
import './layout-v4.css';
import { stripRecoveryParam } from './updateCheck.js';

stripRecoveryParam();

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

createRoot(root).render(<App />);
