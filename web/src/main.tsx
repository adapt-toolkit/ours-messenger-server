import { createRoot } from 'react-dom/client';
import { MotionConfig } from 'framer-motion';
import { App } from './App.js';
import '@fontsource-variable/jetbrains-mono';
import './theme.css';
import './motion.css';
import './app.css';
import './redesign.css';
import './layout-v4.css';
import { stripRecoveryParam } from './updateCheck.js';

stripRecoveryParam();

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

createRoot(root).render(<MotionConfig reducedMotion="user"><App /></MotionConfig>);
