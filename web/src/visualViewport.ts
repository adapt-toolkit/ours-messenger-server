type ViewportWindow = Pick<Window, 'visualViewport' | 'innerHeight' | 'addEventListener' | 'removeEventListener'>;

/** Keep the app shell inside the actually visible iOS viewport while the keyboard is open. */
export function installVisualViewportSizing(
  root: HTMLElement,
  win: ViewportWindow = window,
): () => void {
  const viewport = win.visualViewport;
  const update = () => {
    const height = viewport?.height ?? win.innerHeight;
    const top = viewport?.offsetTop ?? 0;
    root.style.setProperty('--app-viewport-height', `${height}px`);
    root.style.setProperty('--app-viewport-top', `${top}px`);
  };

  update();
  viewport?.addEventListener('resize', update);
  viewport?.addEventListener('scroll', update);
  if (!viewport) win.addEventListener('resize', update);

  return () => {
    viewport?.removeEventListener('resize', update);
    viewport?.removeEventListener('scroll', update);
    if (!viewport) win.removeEventListener('resize', update);
    root.style.removeProperty('--app-viewport-height');
    root.style.removeProperty('--app-viewport-top');
  };
}
