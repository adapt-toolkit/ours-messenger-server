import assert from 'node:assert/strict';
import { installVisualViewportSizing } from '../src/visualViewport.js';

class FakeViewport extends EventTarget {
  height = 844;
  offsetTop = 0;
}

const viewport = new FakeViewport();
const values = new Map<string, string>();
const root = {
  style: {
    setProperty: (name: string, value: string) => values.set(name, value),
    removeProperty: (name: string) => values.delete(name),
  },
} as unknown as HTMLElement;

const viewportWindow = new EventTarget() as EventTarget & { visualViewport: VisualViewport; innerHeight: number };
viewportWindow.visualViewport = viewport as unknown as VisualViewport;
viewportWindow.innerHeight = 900;
const cleanup = installVisualViewportSizing(root, viewportWindow as unknown as Window);
assert.equal(values.get('--app-viewport-height'), '844px');
assert.equal(values.get('--app-viewport-top'), '0px');

viewport.height = 436.4;
viewport.offsetTop = 12.6;
viewport.dispatchEvent(new Event('resize'));
assert.equal(values.get('--app-viewport-height'), '436.4px', 'keyboard resize preserves the exact visible viewport');
assert.equal(values.get('--app-viewport-top'), '12.6px', 'a panned/zoomed viewport keeps the shell aligned without a seam');

cleanup();
assert.equal(values.has('--app-viewport-height'), false);
assert.equal(values.has('--app-viewport-top'), false);

viewport.height = 300;
viewport.dispatchEvent(new Event('resize'));
assert.equal(values.has('--app-viewport-height'), false, 'cleanup removes viewport listeners');

const fallback = new EventTarget() as EventTarget & { innerHeight: number; visualViewport: null };
fallback.innerHeight = 700;
fallback.visualViewport = null;
const fallbackCleanup = installVisualViewportSizing(root, fallback as unknown as Window);
assert.equal(values.get('--app-viewport-height'), '700px', 'older engines fall back to innerHeight');
fallback.innerHeight = 420;
fallback.dispatchEvent(new Event('resize'));
assert.equal(values.get('--app-viewport-height'), '420px', 'fallback follows window resize');
fallbackCleanup();

console.log('visual-viewport OK — initial sizing, keyboard resize, offset and cleanup');
