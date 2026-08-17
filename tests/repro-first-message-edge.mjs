// DISCRIMINATING REPRODUCTION — Developer-4's lead, tested directly.
//
// Two sends between the SAME pair of identities, differing only in whether a
// contact edge already exists when the send happens:
//
//   A. NO EDGE  — sendMessage to an identity that is only in the local contact
//      book. The SDK connects on the way past (connect_local / connect_sibling),
//      carrying the text inside the introduction.
//   B. EDGE     — the ordinary trn send_message path, after the link settled.
//
// For each: the wire_id the send returns, whether a delivered receipt is ever
// emitted, and what getReceipts reports. Everything else is held constant.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memSample, sleep } from './harness.mjs';

const WAIT_MS = Number(process.env.REPRO_WAIT_MS ?? 20000);

memSample('before');
const stateDir = mkdtempSync(join(tmpdir(), 'repro-firstmsg-'));
process.env.OURS_STATE_DIR = stateDir;
process.env.OURS_BROKER_URL = 'wss://invalid.local/none';
process.env.OURS_API_VISIBILITY = 'open';
const { createServer } = await import('node:http');
const port = await new Promise((res) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});
process.env.OURS_PORT = String(port);

const sdk = await import('@ours.network/sdk');
const { startDaemon } = await import('@ours.network/sdk/daemon');
const daemon = await startDaemon({ version: 'test' });
const url = `http://127.0.0.1:${port}`;
const { OursClient } = sdk;

const sender = new OursClient({ url, leaseToken: 'sender-lease' });
const receiver = new OursClient({ url, leaseToken: 'receiver-lease' });

// exposeLocal:true so the host-local contact book can introduce them — this is
// the path a send-to-a-non-contact takes.
await sender.createIdentity({ name: 'Sender', bio: 'repro sender', exposeLocal: true, localAutoAccept: true });
await receiver.createIdentity({ name: 'Receiver', bio: 'repro receiver', exposeLocal: true, localAutoAccept: true });
await sender.setConversationPolicy({ keep_history: true });
await receiver.setConversationPolicy({ keep_history: true });
await sender.readvertiseOnUpgrade();
await receiver.readvertiseOnUpgrade();

const contactsBefore = await sender.listContacts();
console.log(`\nsender contacts BEFORE any send: ${JSON.stringify(contactsBefore.contacts.map((c) => c.name))}`);

const outcomeWireId = (result) =>
  result?.wire_id ?? result?.wireId ?? result?.outcome?.wire_id ?? null;

async function probe(label, expectedText) {
  const t0 = Date.now();
  let reported = new Set();
  let wireId = null;
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    const conv = await sender.getConversation({ contact: 'Receiver' }).catch(() => null);
    const out = conv?.messages.filter((m) => m.dir === 'out' && m.text === expectedText) ?? [];
    if (out.length) {
      const row = out[0];
      wireId = row.wire_id;
      const receipts = await sender.getReceipts({ contact: 'Receiver' }).catch(() => ({ receipts: {} }));
      const line = `wire_id=${JSON.stringify(row.wire_id)} conv.receipt=${JSON.stringify(row.receipt)} getReceipts=${JSON.stringify(receipts.receipts[row.wire_id] ?? null)}`;
      if (!reported.has(line)) {
        console.log(`  +${String(Date.now() - t0).padStart(6)}ms  [${label}] ${line}`);
        reported.add(line);
      }
      if ((receipts.receipts[row.wire_id] ?? null) === 'delivered') break;
    }
    await sleep(250);
  }
  const landed = (await receiver.getConversation({ contact: 'Sender' }).catch(() => null))
    ?.messages.filter((m) => m.dir === 'in' && m.text === expectedText) ?? [];
  console.log(`  [${label}] receiver side: ${landed.length} matching inbound, wire_id=${JSON.stringify(landed[0]?.wire_id ?? null)}`);
  return wireId;
}

// ---- A. NO EDGE: first ever message, connect-on-send -------------------------
console.log('\n=== A. first message with NO pre-existing contact edge ===');
const textA = 'A: first message, no edge';
const resultA = await sender.sendMessage({ contact: 'Receiver', text: textA });
console.log(`  sendMessage returned: ${JSON.stringify(resultA)}`);
console.log(`  outcome wire_id: ${JSON.stringify(outcomeWireId(resultA))}`);
await probe('A', textA);

// ---- B. EDGE: the same pair, once the link exists ----------------------------
console.log('\n=== B. second message, contact edge now exists ===');
const contactsMid = await sender.listContacts();
console.log(`  sender contacts now: ${JSON.stringify(contactsMid.contacts.map((c) => c.name))}`);
const textB = 'B: second message, edge exists';
const resultB = await sender.sendMessage({ contact: 'Receiver', text: textB });
console.log(`  sendMessage returned: ${JSON.stringify(resultB)}`);
console.log(`  outcome wire_id: ${JSON.stringify(outcomeWireId(resultB))}`);
await probe('B', textB);

console.log('\n--- final sender view ---');
const finalConv = await sender.getConversation({ contact: 'Receiver' });
const finalReceipts = await sender.getReceipts({ contact: 'Receiver' });
for (const m of finalConv.messages) {
  console.log(`  ${m.dir}  wire_id=${JSON.stringify(m.wire_id)}  receipt=${JSON.stringify(m.receipt)}  getReceipts=${JSON.stringify(finalReceipts.receipts[m.wire_id] ?? null)}  text=${JSON.stringify(m.text)}`);
}

await daemon.close?.();
rmSync(stateDir, { recursive: true, force: true });
memSample('after');
process.exit(0);
