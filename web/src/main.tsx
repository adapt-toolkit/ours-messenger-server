import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';

const root = document.getElementById('app');
if (!root) throw new Error('missing #app root');

createRoot(root).render(<App />);
