import { createRoot } from 'react-dom/client';
import { MotionConfig } from 'framer-motion';
import { App } from './App.js';
import { lazy, Suspense } from 'react';
const FleetApp = lazy(() => import('./fleet/FleetApp'));
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

createRoot(root).render(<MotionConfig reducedMotion="user">{window.location.pathname === '/fleet' || window.location.pathname.startsWith('/fleet/') ? <Suspense fallback={<div className="centered-screen">Loading preview…</div>}><FleetApp /></Suspense> : <App />}</MotionConfig>);
