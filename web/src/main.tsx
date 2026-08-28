import { createRoot } from 'react-dom/client';
import { MotionConfig } from 'framer-motion';
import { App } from './App.js';
import '@fontsource-variable/jetbrains-mono';
import './theme.css';
import './motion.css';
import './app.css';
import './onboarding.css';
import './redesign.css';
import './dark-v3.css';
import './layout-v4.css';
import { stripRecoveryParam } from './updateCheck.js';
import { installVisualViewportSizing } from './visualViewport.js';

stripRecoveryParam();

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

installVisualViewportSizing(root);

createRoot(root).render(<MotionConfig reducedMotion="user"><App /></MotionConfig>);
