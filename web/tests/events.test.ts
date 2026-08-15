import assert from 'node:assert/strict';
import { connectEvents } from '../src/events.js';
import type { ConnectionState, ServerEvent } from '../src/types.js';

class FakeEventSource {
  static instance: FakeEventSource;
  readonly listeners = new Map<string, (event: MessageEvent) => void>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(readonly url: string) { FakeEventSource.instance = this; }
  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    this.listeners.set(type, listener as (event: MessageEvent) => void);
  }
  close() { this.closed = true; }
  emit(type: string, payload: unknown) {
    this.listeners.get(type)?.({ data: JSON.stringify(payload) } as MessageEvent);
  }
}

Object.defineProperty(globalThis, 'EventSource', { value: FakeEventSource, configurable: true });
const events: ServerEvent[] = [];
const states: ConnectionState[] = [];
const disconnect = connectEvents((event) => events.push(event), (state) => states.push(state));
const source = FakeEventSource.instance;
assert.equal(source.url, '/api/events');
assert.ok(source.listeners.has('file_received'), 'foreground media invalidations have a dedicated EventSource listener');
source.onopen?.();
source.emit('file_received', { v: 1, contact_id: 'PEER', wire_id: 'FILE-1', date: '2026-08-15T00:00:00Z' });
assert.equal(events[0]?.type, 'file_received');
assert.deepEqual(states, ['connecting', 'live']);
disconnect();
assert.equal(source.closed, true);

console.log('web-events OK — file_received is bound, parsed, and delivered');
