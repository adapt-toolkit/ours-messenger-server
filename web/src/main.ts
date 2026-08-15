import { MessengerApp } from './App.js';

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('missing #app root');
const app = new MessengerApp(root);
void app.start();
window.addEventListener('pagehide', () => app.stop(), { once: true });
