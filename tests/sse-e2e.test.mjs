import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { serveApi } from '../src/api.ts';
import { MessengerEventBus } from '../src/events.ts';

class FakeRequest extends EventEmitter {
  method = 'GET';
  url = '/api/events';
  headers = { 'last-event-id': 'ignored-v1' };
  async *[Symbol.asyncIterator]() {}
}

class FakeResponse extends EventEmitter {
  statusCode = 0;
  headers = {};
  chunks = [];
  destroyed = false;
  writableEnded = false;
  writeHead(status, headers) { this.statusCode = status; this.headers = headers; return this; }
  flushHeaders() {}
  write(chunk) { this.chunks.push(String(chunk)); return true; }
  end(chunk) { if (chunk) this.write(chunk); this.writableEnded = true; this.emit('finish'); return this; }
}

const events = new MessengerEventBus();
const deps = {
  runtime: { client: {}, described: {} },
  push: {},
  config: {},
  buildInfo: { name: 'test', version: 'test' },
  watcherStats: () => ({}),
  events,
  identityCid: 'BOUND-CID',
  sseHeartbeatMs: 10_000,
};
const req = new FakeRequest();
const res = new FakeResponse();
const serving = serveApi(req, res, deps);
await new Promise((resolve) => setImmediate(resolve));

assert.equal(res.statusCode, 200);
assert.equal(res.headers['content-type'], 'text/event-stream');
assert.equal(res.headers['cache-control'], 'no-cache, no-transform');
assert.equal(res.headers['x-accel-buffering'], 'no');

events.publish({ type: 'message_received', contact_id: 'PEER', wire_id: 'WIRE', date: 'DATE' });
events.publish({ type: 'receipt_received', contact_id: 'PEER', kind: 'read', wire_ids: ['WIRE'], date: 'DATE2' });
events.publish({ type: 'sync_required', reason: 'daemon_reconnected' });
await new Promise((resolve) => setImmediate(resolve));
await new Promise((resolve) => setImmediate(resolve));
await new Promise((resolve) => setImmediate(resolve));

const wire = res.chunks.join('');
const frames = wire.split('\n\n').filter((frame) => frame.startsWith('event:'));
const decode = (frame) => ({
  event: frame.split('\n').find((line) => line.startsWith('event: '))?.slice(7),
  data: JSON.parse(frame.split('\n').find((line) => line.startsWith('data: '))?.slice(6) ?? '{}'),
  raw: frame,
});
const [connected, inbound, read, reconnected] = frames.map(decode);
assert.equal(connected.event, 'sync_required');
assert.deepEqual(connected.data, { v: 1, reason: 'connected', identity: 'BOUND-CID' });
assert.ok(!connected.raw.includes('id:'), 'v1 promises no event replay id');
assert.deepEqual(inbound.data, { v: 1, contact_id: 'PEER', wire_id: 'WIRE', date: 'DATE' });
assert.deepEqual(read.data, { v: 1, contact_id: 'PEER', kind: 'read', wire_ids: ['WIRE'], date: 'DATE2' });
assert.equal(reconnected.data.reason, 'daemon_reconnected');
assert.ok(!wire.includes('message text') && !wire.includes('invite') && !wire.includes('file path'));

req.emit('close');
await serving;
assert.equal(events.size, 0, 'socket close releases the SSE subscriber');
assert.equal(res.writableEnded, true);
events.close();

class BackpressuredResponse extends FakeResponse {
  blocked = true;
  write(chunk) {
    this.chunks.push(String(chunk));
    return !this.blocked;
  }
  drain() {
    this.blocked = false;
    this.emit('drain');
  }
}

const slowEvents = new MessengerEventBus();
const slowReq = new FakeRequest();
const slowRes = new BackpressuredResponse();
const slowServing = serveApi(slowReq, slowRes, { ...deps, events: slowEvents, sseQueueLimit: 1 });
await new Promise((resolve) => setImmediate(resolve));

// Pace the publisher so an HTTP writer that ignores `write() === false` can
// drain the process-local bus between events and reproduce unbounded buffering
// in the real ServerResponse layer.
for (let i = 0; i < 20; i++) {
  slowEvents.publish({ type: 'message_received', contact_id: 'PEER', wire_id: `WIRE-${i}`, date: 'DATE' });
  await new Promise((resolve) => setImmediate(resolve));
}

const beforeDrain = slowRes.chunks.join('');
const detailedBeforeDrain = beforeDrain.split('\n\n').filter((frame) => frame.startsWith('event: message_received')).length;
slowRes.drain();
await new Promise((resolve) => setImmediate(resolve));
await new Promise((resolve) => setImmediate(resolve));
const slowWire = slowRes.chunks.join('');
const overflowFrames = slowWire.split('\n\n').filter((frame) => frame.includes('"reason":"overflow"')).length;
slowReq.emit('close');
await slowServing;
slowEvents.close();

assert.equal(detailedBeforeDrain, 0, 'a backpressured HTTP writer must stop consuming detailed frames');
assert.equal(overflowFrames, 1, 'bounded overflow collapses missed details to one snapshot recovery signal');
assert.equal(slowEvents.size, 0, 'backpressured socket close releases the SSE subscriber and drain wait');

console.log('sse-e2e OK — headers, metadata privacy, backpressure overflow recovery, reconnect, disconnect');
