import { useEffect, useId, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Icon } from './icons';

let renderSerial = 0;
const MERMAID_MIN_SCALE = 0.25;
const MERMAID_MAX_SCALE = 8;

type MermaidTheme = 'default' | 'dark';

let mermaidRenderQueue: Promise<void> = Promise.resolve();

function readMermaidTheme(): MermaidTheme {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('theme-dark') ? 'dark' : 'default';
}

function useMermaidTheme(): MermaidTheme {
  const [theme, setTheme] = useState<MermaidTheme>(readMermaidTheme);

  useEffect(() => {
    const root = document.documentElement;
    const syncTheme = () => setTheme(readMermaidTheme());
    const observer = new MutationObserver(syncTheme);
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    syncTheme();
    return () => observer.disconnect();
  }, []);

  return theme;
}

function renderMermaid(id: string, source: string, theme: MermaidTheme, isLive: () => boolean) {
  const render = mermaidRenderQueue.then(async () => {
    if (!isLive()) return '';
    const { default: mermaid } = await import('mermaid');
    if (!isLive()) return '';
    // Mermaid configuration is global. Keep initialize + render in one
    // serialized critical section so another diagram cannot replace the
    // palette between those calls.
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme,
      fontFamily: 'Arial, sans-serif',
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      suppressErrorRendering: true,
    });
    if (source.length > 50_000) throw new Error('Diagram exceeds the rendering limit.');
    if (/^\s*---(?:\r?\n|$)|%%\s*\{/.test(source)) throw new Error('Diagram configuration overrides are not supported.');
    await document.fonts.ready;
    if (!isLive()) return '';
    const container = document.createElement('div');
    container.style.fontFamily = 'Arial, sans-serif';
    container.style.fontSize = '16px';
    container.style.lineHeight = 'normal';
    container.style.position = 'absolute';
    container.style.visibility = 'hidden';
    document.body.append(container);
    try {
      const result = await mermaid.render(id, source, container);
      // An SVG image has no surrounding app styles or DOM IDs. Give it real
      // intrinsic dimensions instead of the replaced-element 300×150 default.
      const xml = new DOMParser().parseFromString(result.svg, 'image/svg+xml');
      const svg = xml.documentElement;
      const bounds = svg.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
      if (svg.localName !== 'svg' || !bounds || bounds.length !== 4 || !bounds.every(Number.isFinite)
        || bounds[2] <= 0 || bounds[3] <= 0) throw new Error('Diagram has no usable dimensions.');
      svg.setAttribute('width', String(bounds[2]));
      svg.setAttribute('height', String(bounds[3]));
      return URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' }));
    } finally {
      container.remove();
    }
  });
  mermaidRenderQueue = render.then(() => undefined, () => undefined);
  return render;
}

function clampMermaidScale(value: number) {
  return Math.min(MERMAID_MAX_SCALE, Math.max(MERMAID_MIN_SCALE, value));
}

function MermaidFullscreen(props: { svg: string; theme: MermaidTheme; onClose: () => void }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    panX: number;
    panY: number;
  } | null>(null);
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);

  const resetView = () => {
    setScale(1);
    setPan({ x: 0, y: 0 });
  };

  const zoomAt = (nextScale: number, clientX?: number, clientY?: number) => {
    const clamped = clampMermaidScale(nextScale);
    if (clamped === scale) return;
    const rect = viewportRef.current?.getBoundingClientRect();
    if (rect) {
      const offsetX = (clientX ?? rect.left + rect.width / 2) - rect.left - rect.width / 2;
      const offsetY = (clientY ?? rect.top + rect.height / 2) - rect.top - rect.height / 2;
      const ratio = clamped / scale;
      setPan((current) => ({
        x: offsetX - ratio * (offsetX - current.x),
        y: offsetY - ratio * (offsetY - current.y),
      }));
    }
    setScale(clamped);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        zoomAt(scale * 1.25);
      } else if (event.key === '-') {
        event.preventDefault();
        zoomAt(scale / 1.25);
      } else if (event.key === '0') {
        event.preventDefault();
        resetView();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) props.onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="mermaid-fullscreen-backdrop" />
        <Dialog.Content
          className="mermaid-fullscreen"
          data-mermaid-theme={props.theme}
          aria-describedby="mermaid-fullscreen-help"
        >
          <Dialog.Title className="mermaid-fullscreen-title">Diagram viewer</Dialog.Title>
          <div className="mermaid-fullscreen-tools">
            <button className="icon-btn" aria-label="Zoom out" title="Zoom out (−)" onClick={() => zoomAt(scale / 1.25)}>
              <Icon name="minus" />
            </button>
            <button className="mermaid-zoom-value" onClick={resetView} title="Reset zoom and position">
              {Math.round(scale * 100)}%
            </button>
            <button className="icon-btn" aria-label="Zoom in" title="Zoom in (+)" onClick={() => zoomAt(scale * 1.25)}>
              <Icon name="plus" />
            </button>
            <Dialog.Close asChild>
              <button className="icon-btn" aria-label="Close diagram viewer" title="Close (Esc)">
                <Icon name="close" />
              </button>
            </Dialog.Close>
          </div>
          <div
            ref={viewportRef}
            tabIndex={0}
            role="region"
            aria-label="Diagram navigation; use arrow keys to pan"
            onKeyDown={(event) => {
              const offset = { ArrowLeft: [40, 0], ArrowRight: [-40, 0], ArrowUp: [0, 40], ArrowDown: [0, -40] }[event.key];
              if (!offset) return;
              event.preventDefault();
              setPan((current) => ({ x: current.x + offset[0], y: current.y + offset[1] }));
            }}
            className={'mermaid-fullscreen-viewport' + (dragging ? ' dragging' : '')}
            onWheel={(event) => {
              event.preventDefault();
              zoomAt(scale * Math.exp(-event.deltaY * 0.0015), event.clientX, event.clientY);
            }}
            onDoubleClick={(event) => zoomAt(scale * 1.5, event.clientX, event.clientY)}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              dragRef.current = {
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                panX: pan.x,
                panY: pan.y,
              };
              event.currentTarget.setPointerCapture(event.pointerId);
              setDragging(true);
            }}
            onPointerMove={(event) => {
              const drag = dragRef.current;
              if (!drag || drag.pointerId !== event.pointerId) return;
              setPan({
                x: drag.panX + event.clientX - drag.startX,
                y: drag.panY + event.clientY - drag.startY,
              });
            }}
            onPointerUp={(event) => {
              if (dragRef.current?.pointerId !== event.pointerId) return;
              dragRef.current = null;
              setDragging(false);
              event.currentTarget.releasePointerCapture(event.pointerId);
            }}
            onPointerCancel={() => {
              dragRef.current = null;
              setDragging(false);
            }}
          >
            <div
              className="mermaid-fullscreen-canvas"
              style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})` }}
            >
              <img src={props.svg} alt="Mermaid diagram" />
            </div>
          </div>
          <Dialog.Description id="mermaid-fullscreen-help" className="mermaid-fullscreen-help">
            Scroll or +/− to zoom · drag or arrow keys to move · 0 to reset
          </Dialog.Description>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function MermaidDiagram({ source }: { source: string }) {
  const rawId = useId();
  const [svg, setSvg] = useState('');
  const [error, setError] = useState('');
  const [renderedTheme, setRenderedTheme] = useState<MermaidTheme>('default');
  const [fullscreen, setFullscreen] = useState(false);
  const theme = useMermaidTheme();

  useEffect(() => {
    let live = true;
    let url = '';
    const id = `mermaid-${++renderSerial}-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
    setSvg('');
    setError('');
    setFullscreen(false);
    void renderMermaid(id, source, theme, () => live)
      .then((rendered) => {
        if (live) {
          setRenderedTheme(theme);
          url = rendered;
          setSvg(rendered);
        } else {
          URL.revokeObjectURL(rendered);
        }
      })
      .catch((err) => {
        if (live) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [rawId, source, theme]);

  return (
    <div className="mermaid-block">
      {error ? <p className="markdown-mermaid-error" role="status">Unable to render diagram: {error}</p> : !svg ? (
        <div className="markdown-mermaid-loading" role="status">Rendering diagram…</div>
      ) : (
        <div className="markdown-mermaid" data-mermaid-theme={renderedTheme}>
          <button className="icon-btn markdown-mermaid-expand" aria-label="View diagram fullscreen"
            title="View diagram fullscreen" onClick={() => setFullscreen(true)}><Icon name="maximize" /></button>
          <div className="markdown-mermaid-diagram" tabIndex={0} role="region" aria-label="Scrollable Mermaid diagram">
            <img src={svg} alt="Mermaid diagram; original source follows" onError={() => setError('Diagram image could not be displayed.')} />
          </div>
        </div>
      )}
      <details className="mermaid-source" open={error ? true : undefined}>
        <summary>Mermaid source</summary>
        <pre><code>{source}</code></pre>
      </details>
      {fullscreen && svg && !error && (
        <MermaidFullscreen svg={svg} theme={renderedTheme} onClose={() => setFullscreen(false)} />
      )}
    </div>
  );
}

