const template = document.querySelector('#workspaceTemplate');
document.querySelectorAll('[data-workspace]').forEach((host) => host.append(template.content.cloneNode(true)));
const comparison = document.querySelector('.comparison');
const mobile = document.querySelector('#mobileToggle');
const pane = document.querySelector('#mobilePane');
mobile.addEventListener('click', () => { const active = comparison.classList.toggle('mobile-preview'); comparison.classList.remove('mobile-rooms'); mobile.setAttribute('aria-pressed', String(active)); pane.disabled = !active; pane.textContent = 'Show room list'; });
pane.addEventListener('click', () => { const rooms = comparison.classList.toggle('mobile-rooms'); pane.textContent = rooms ? 'Show conversation' : 'Show room list'; });
const dialog = document.querySelector('#details');
document.querySelectorAll('[data-dialog-theme]').forEach((button) => button.addEventListener('click', () => {
  const dark = button.closest('.theme').classList.contains('theme-dark');
  dialog.className = `theme ${dark ? 'theme-dark' : 'theme-light'}`;
  dialog.showModal();
}));
document.querySelector('#dialogClose').addEventListener('click', () => dialog.close());
