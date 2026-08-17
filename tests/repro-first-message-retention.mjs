// Follow-up to repro-first-message-edge: where does the no-edge first message
// actually END UP, and is anything retained for redrive?
//
// Captures, for the introduction-carried first message: the sender's history,
// the sender's receipts, the receiver's conversation, and the receiver's
// incoming (unconsumed) queue. Then repeats for an ordinary edge send.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memSample, sleep } from './harness.mjs';

const stateDir = mkdtempSync(join(tmpdir(), 'repro-retention-'));
process.env.OURS_STATE_DIR = stateDir;
process.env.OURS_BROKER_URL = 'wss://invalid.local/none';
process.env.OURS_API_VISIBILITY = 'open';
const { createServer } = await import('node:http');
const port = await new Promise((res) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});
process.env.OURS_PORT = String(port);
memSample('before');

const sdk = await import('@ours.network/sdk');
const { startDaemon } = await import('@ours.network/sdk/daemon');
const daemon = await startDaemon({ version: 'test' });
const url = `http://127.0.0.1:${port}`;
const { OursClient } = sdk;

const sender = new OursClient({ url, leaseToken: 'sender-lease' });
const receiver = new OursClient({ url, leaseToken: 'receiver-lease' });
await sender.createIdentity({ name: 'Sender', bio: 's', exposeLocal: true, localAutoAccept: true });
await receiver.createIdentity({ name: 'Receiver', bio: 'r', exposeLocal: true, localAutoAccept: true });
await sender.setConversationPolicy({ keep_history: true });
await receiver.setConversationPolicy({ keep_history: true });
await sender.readvertiseOnUpgrade();
await receiver.readvertiseOnUpgrade();

const dump = async (label) => {
  const senderConv = await sender.getConversation({ contact: 'Receiver' }).catch((e) => ({ error: String(e) }));
  const senderReceipts = await sender.getReceipts({ contact: 'Receiver' }).catch((e) => ({ error: String(e) }));
  const receiverConv = await receiver.getConversation({ contact: 'Sender' }).catch((e) => ({ error: String(e) }));
  const receiverIncoming = await receiver.listIncomingMessages().catch((e) => ({ error: String(e) }));
  console.log(`\n---- ${label} ----`);
  console.log('  sender history :', JSON.stringify((senderConv.messages ?? []).map((m) => ({ dir: m.dir, wire: m.wire_id, receipt: m.receipt, text: m.text }))));
  console.log('  sender receipts:', JSON.stringify(senderReceipts.receipts ?? senderReceipts));
  console.log('  recvr history  :', JSON.stringify((receiverConv.messages ?? []).map((m) => ({ dir: m.dir, wire: m.wire_id, read: m.read, text: m.text }))));
  console.log('  recvr incoming :', JSON.stringify((Array.isArray(receiverIncoming) ? receiverIncoming : []).map((m) => ({ wire: m.wire_id, from: m.from?.name, text: m.text }))));
};

console.log('\n=== A. NO EDGE — first message rides the introduction ===');
const a = await sender.sendMessage({ contact: 'Receiver', text: 'A-no-edge' });
console.log('  sendMessage ->', JSON.stringify(a));
await sleep(3000);
await dump('after A (3s)');

console.log('\n=== B. EDGE EXISTS — ordinary send ===');
const b = await sender.sendMessage({ contact: 'Receiver', text: 'B-with-edge' });
console.log('  sendMessage ->', JSON.stringify(b));
await sleep(3000);
await dump('after B (3s)');

// Retention probe: an ordinary send is tracked as unacked until the peer acks.
// If the introduction-carried message was never noted, nothing about it can be
// redriven and it can never acquire a receipt afterwards.
await sleep(3000);
await dump('after settle (+3s)');

await daemon.close?.();
rmSync(stateDir, { recursive: true, force: true });
memSample('after');
process.exit(0);
