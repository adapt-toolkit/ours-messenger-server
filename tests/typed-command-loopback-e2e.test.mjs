import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHarnessDaemon, until } from './harness.mjs';

const daemon = await startHarnessDaemon('typed-loopback');
const appState = mkdtempSync(join(tmpdir(), 'messenger-typed-loopback-app-'));
const publicOrigin = 'http://messenger.test';
let server;

try {
  const { OursClient } = daemon.sdk;
  const provision = new OursClient({ url: daemon.url, leaseToken: 'typed-provision' });
  const me = await provision.createRootIdentity({
    name: 'Me', bio: 'messenger', exposeLocal: true, localAutoAccept: true, skipIfRootExists: false,
  });
  const peer = new OursClient({ url: daemon.url, leaseToken: 'typed-peer' });
  const peerIdentity = await peer.createIdentity({
    name: 'Peer', bio: 'recipient', exposeLocal: true, localAutoAccept: true,
  });
  let executions = 0;
  await peer.registerCommands([
    {
      name: 'math.double', description: 'Double one number',
      input_schema: { type: 'object', required: ['value'], properties: { value: { type: 'integer' } } },
      handler: async (args, context) => {
        executions++;
        assert.equal(context.sender_cid, me.info.cid, 'handler authorization context is the authenticated Messenger CID');
        return { value: args.value * 2 };
      },
    },
    {
      name: 'always.fail', input_schema: { type: 'object', properties: {} },
      handler: async () => { throw new Error('private recipient failure'); },
    },
  ]);
  assert.equal((await peer.listSelfCommands())[0]?.name, 'math.double');
  const invite = await provision.generateInvite({});
  await peer.addContact({ invite: invite.blob });
  await until('typed peer contact', async () => (await peer.listContacts()).contacts.some((row) => row.container_id === me.info.cid) || undefined);
  await until('typed Messenger contact', async () => (await provision.listContacts()).contacts.some((row) => row.container_id === peerIdentity.info.cid) || undefined);
  await provision.releaseLease();

  const { start } = await import('../src/server.ts');
  const boot = async (typedCommands = true) => start({
    host: '127.0.0.1', port: 0, publicOrigin, identity: 'Me', force: false,
    stateDir: appState, typedCommands,
  }, { name: 'messenger', version: 'test', sha: 'typed-loopback', dirty: false });
  server = await boot();
  let base = `http://127.0.0.1:${server.port}`;
  const api = async (method, path, body) => {
    const response = await fetch(base + path, {
      method,
      headers: method === 'GET' ? {} : { 'content-type': 'application/json', origin: publicOrigin, 'x-ours-messenger-csrf': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null };
  };

  const catalog = await until('recipient command discovery', async () => {
    const response = await api('GET', `/api/contacts/${peerIdentity.info.cid}/commands`);
    return response.status === 200 && response.json.commands.some((row) => row.name === 'math.double') ? response.json : undefined;
  }, 30_000);
  assert.equal(catalog.recipient_cid, peerIdentity.info.cid, 'REST discovery is bound to the authenticated recipient CID');

  const invocationId = randomUUID();
  const request = {
    contact: peerIdentity.info.cid, recipient_cid: peerIdentity.info.cid, command: 'math.double',
    arguments: { value: 21 }, invocation_id: invocationId, catalog_fingerprint: catalog.fingerprint, confirmed: true,
  };
  const sent = await api('POST', '/api/commands/send', request);
  assert.equal(sent.status, 200);
  assert.equal(sent.json.status, 'accepted');
  assert.equal(sent.json.deduplicated, false);

  await until('recipient handler execution', async () => {
    const consumed = await peer.getMessages();
    return consumed.commands_handled === 1 ? consumed : undefined;
  });
  assert.equal(executions, 1, 'the real recipient handler executes exactly once');
  const completed = await until('correlated command result history', async () => {
    const response = await api('GET', `/api/conversations/${peerIdentity.info.cid}/page?limit=50`);
    const command = response.json.messages.find((row) => row.message_kind === 'command');
    const result = response.json.messages.find((row) => row.message_kind === 'command_result');
    return command && result ? { response, command, result } : undefined;
  });
  assert.deepEqual(completed.result.typed, { kind: 'command_result', outcome: { ok: true, result: { value: 42 } } });
  assert.equal(completed.result.reply_to.wire_id, completed.command.wire_id, 'result reply targets the exact outgoing typed command');
  assert.equal(completed.result.peer_cid, peerIdentity.info.cid, 'result carries the authenticated expected peer CID');

  const duplicate = await api('POST', '/api/commands/send', request);
  assert.equal(duplicate.json.deduplicated, true);
  assert.equal(duplicate.json.wire_id, sent.json.wire_id);
  assert.equal(executions, 1, 'duplicate POST cannot create a second recipient execution');

  await server.close(); server = undefined;
  server = await boot(); base = `http://127.0.0.1:${server.port}`;
  const restartReplay = await api('POST', '/api/commands/send', request);
  assert.equal(restartReplay.json.deduplicated, true, 'restart replays the durable attempt');
  assert.equal(restartReplay.json.wire_id, sent.json.wire_id);
  assert.equal(executions, 1);

  const failureSend = await api('POST', '/api/commands/send', {
    contact: peerIdentity.info.cid, recipient_cid: peerIdentity.info.cid, command: 'always.fail', arguments: {},
    invocation_id: randomUUID(), catalog_fingerprint: catalog.fingerprint, confirmed: true,
  });
  assert.equal(failureSend.status, 200);
  await until('recipient refusal/failure result', async () => (await peer.getMessages()).commands_handled === 1 || undefined);
  const failureHistory = await until('failed result history', async () => {
    const response = await api('GET', `/api/conversations/${peerIdentity.info.cid}/page?limit=50`);
    return response.json.messages.find((row) => row.message_kind === 'command_result'
      && row.reply_to?.wire_id === failureSend.json.wire_id) ?? undefined;
  });
  assert.deepEqual(failureHistory.typed, { kind: 'command_result', outcome: { ok: false, error: 'handler_failed' } },
    'recipient exceptions become a bounded safe failure without private error leakage');

  await server.close(); server = undefined;
  server = await boot(false); base = `http://127.0.0.1:${server.port}`;
  assert.equal((await api('GET', `/api/contacts/${peerIdentity.info.cid}/commands`)).status, 404, 'rollback disables discovery');
  assert.equal((await api('POST', '/api/commands/send', request)).status, 404, 'rollback disables typed send');
  const rolledBackHistory = await api('GET', `/api/conversations/${peerIdentity.info.cid}/page?limit=50`);
  assert.equal(rolledBackHistory.status, 200);
  assert.ok(rolledBackHistory.json.messages.some((row) => row.message_kind === 'command_result'),
    'rollback preserves typed chronology without registering Messenger handlers');
  const ordinary = await api('POST', '/api/messages/send', { contact: peerIdentity.info.cid, text: 'ordinary after rollback' });
  assert.equal(ordinary.status, 200, 'ordinary text remains available with typed commands disabled');

  await peer.releaseLease();
  console.log('typed-command-loopback-e2e OK — real discovery/send/handler/result, duplicate, restart, failure, rollback');
} finally {
  if (server) await server.close();
  await daemon.close();
  rmSync(appState, { recursive: true, force: true });
}
