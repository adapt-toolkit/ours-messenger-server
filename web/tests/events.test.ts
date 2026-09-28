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
source.onerror?.();
source.onopen?.();
source.emit('receipt_received', {
  v: 1, contact_id: 'ROOM', kind: 'delivered', wire_ids: ['ROOM-WIRE'], date: '2026-08-15T00:00:01Z',
});
assert.deepEqual(events[1], {
  v: 1, type: 'receipt_received', contact_id: 'ROOM', kind: 'delivered', wire_ids: ['ROOM-WIRE'], date: '2026-08-15T00:00:01Z',
}, 'the same EventSource subscription delivers room receipts after reconnect/resume');
assert.deepEqual(states, ['connecting', 'live', 'retrying', 'live']);
disconnect();
assert.equal(source.closed, true);

console.log('web-events OK — file and room-receipt events survive reconnect/resume');
