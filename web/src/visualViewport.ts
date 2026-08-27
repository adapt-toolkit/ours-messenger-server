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
  // WebKit can update visualViewport during an orientation/viewport change
  // before dispatching its own resize event. The window event closes that
  // timing gap; update still reads the visual viewport as the source of truth.
  win.addEventListener('resize', update);

  return () => {
    viewport?.removeEventListener('resize', update);
    viewport?.removeEventListener('scroll', update);
    win.removeEventListener('resize', update);
    root.style.removeProperty('--app-viewport-height');
    root.style.removeProperty('--app-viewport-top');
  };
}
