import assert from 'node:assert/strict';
import { presenceUrl } from '../src/presence.js';

assert.equal(presenceUrl({ protocol: 'https:', host: 'messenger.example' } as Location), 'wss://messenger.example/api/presence');
assert.equal(presenceUrl({ protocol: 'http:', host: '127.0.0.1:3000' } as Location), 'ws://127.0.0.1:3000/api/presence');

console.log('web-presence OK — same-origin secure and local socket URLs');
