import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { projectHistoryPage } from '../src/conversation.ts';
import { startHarnessDaemon, until } from './harness.mjs';

const daemon = await startHarnessDaemon('shared-e2e');
try {
  const { OursClient } = daemon.sdk;
  const provision = new OursClient({ url: daemon.url, leaseToken: 'provision' });
  const peer = new OursClient({ url: daemon.url, leaseToken: 'peer' });

  const human = await provision.createRootIdentity({
    name: 'Human', bio: 'messenger identity', expose_local: true,
    local_auto_accept: true, skip_if_root_exists: false,
  });
  await provision.releaseLease();
  const peerIdentity = await peer.createIdentity({
    name: 'Peer', bio: 'sender', expose_local: true, local_auto_accept: true,
  });
  const messenger = new OursClient({ url: daemon.url, leaseToken: 'messenger' });
  await messenger.chooseIdentity({ name: 'Human', force: false });
  assert.equal((await messenger.currentIdentity()).cid, human.info.cid);

  const sent = await peer.sendMessage({ contact: 'Human', text: 'persisted outside the packet' });
  assert.equal(sent.sent, true);

  const page = await until('messenger history projection', async () => {
    const [history, summary] = await Promise.all([
      messenger.listHistory({ peer_cid: peerIdentity.info.cid, limit: 10 }),
      messenger.getHistorySummary({ peer_cid: peerIdentity.info.cid }),
    ]);
    const projected = projectHistoryPage('Peer', history, summary);
    return projected.messages.some((row) => row.text === 'persisted outside the packet') ? projected : undefined;
  });
  assert.equal(page.unread, 1);
  assert.equal((await messenger.listIncomingMessages()).length, 1,
    'history reads are non-consuming');

  const unread = await messenger.listIncomingMessages();
  const marked = await messenger.getMessages({ wire_ids: unread.map((row) => row.wire_id) });
  assert.equal(marked.messages.length, 1);
  assert.deepEqual(await messenger.listIncomingMessages(), []);

  const durable = await messenger.listHistory({ peer_cid: peerIdentity.info.cid });
  assert.equal(durable.items.at(0)?.text, 'persisted outside the packet');
  assert.equal(durable.items.at(0)?.inbox_state, 'read');
  assert.equal(existsSync(join(daemon.stateDir, 'Human', 'history.sqlite3')), true,
    'identity history is stored in the daemon filesystem');

  await messenger.releaseLease();
  assert.equal((await peer.version()).stateDir, daemon.stateDir,
    'closing messenger releases its lease without stopping the shared daemon');
  await peer.releaseLease();
  console.log('shared-daemon-e2e OK — one daemon, selected identity, durable history, selective read');
} finally {
  await daemon.close();
}
