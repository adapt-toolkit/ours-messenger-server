import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startHarnessDaemon, until } from './harness.mjs';

const candidateDir = resolve(process.env.OURS_SDK_CANDIDATE_DIR ?? '');
const candidateSha = process.env.OURS_SDK_CANDIDATE_SHA ?? '';
assert.ok(process.env.OURS_SDK_CANDIDATE_DIR && /^[0-9a-f]{40}$/.test(candidateSha),
  'set OURS_SDK_CANDIDATE_DIR and exact 40-character OURS_SDK_CANDIDATE_SHA');
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: candidateDir, encoding: 'utf8' }).trim(), candidateSha,
  'runtime integration must use the declared immutable SDK candidate');
assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: candidateDir, encoding: 'utf8' }).trim(), '',
  'runtime SDK candidate worktree must be clean');

const sdkEntry = join(candidateDir, 'dist', 'index.js');
const cliEntry = join(candidateDir, 'packages', 'cli', 'dist', 'cli.js');
assert.ok(existsSync(sdkEntry) && existsSync(cliEntry),
  'build the exact SDK candidate and its CLI workspace before this integration gate');

const daemon = await startHarnessDaemon('runtime-catalog-reopen', { sdkEntry, cliEntry });
const appState = mkdtempSync(join(tmpdir(), 'messenger-runtime-catalog-app-'));
const publicOrigin = 'http://messenger.test';
let server;

try {
  const { OursClient } = daemon.sdk;
  const provision = new OursClient({ url: daemon.url, leaseToken: 'catalog-provision' });
  const me = await provision.createRootIdentity({
    name: 'Me', bio: 'messenger', exposeLocal: true, localAutoAccept: true, skipIfRootExists: false,
  });
  const peer = new OursClient({ url: daemon.url, leaseToken: 'catalog-peer' });
  const peerIdentity = await peer.createIdentity({
    name: 'Peer', bio: 'recipient', exposeLocal: true, localAutoAccept: true,
  });

  const invite = await provision.generateInvite({});
  await peer.addContact({ invite: invite.blob });
  await until('existing peer contact', async () =>
    (await peer.listContacts()).contacts.some((row) => row.container_id === me.info.cid) || undefined);
  await until('existing Messenger contact', async () =>
    (await provision.listContacts()).contacts.some((row) => row.container_id === peerIdentity.info.cid) || undefined);
  await provision.releaseLease();

  const { start } = await import('../src/server.ts');
  server = await start({
    host: '127.0.0.1', port: 0, publicOrigin, identity: 'Me', force: false,
    stateDir: appState, typedCommands: true,
  }, { name: 'messenger', version: 'test', sha: 'runtime-catalog-reopen', dirty: false });
  const base = `http://127.0.0.1:${server.port}`;
  const catalog = async () => {
    const response = await fetch(`${base}/api/contacts/${peerIdentity.info.cid}/commands`);
    assert.equal(response.status, 200);
    return response.json();
  };

  assert.deepEqual((await catalog()).commands, [], 'an existing contact initially advertises no commands');
  await peer.registerCommands([{
    name: 'runtime.echo',
    input_schema: { type: 'object', properties: { value: { type: 'string' } } },
    handler: async (args) => args,
  }]);
  const added = await until('late registered catalog reaches existing contact', async () => {
    const current = await catalog();
    return current.commands.some((row) => row.name === 'runtime.echo') ? current : undefined;
  }, 30_000);
  assert.equal(added.recipient_cid, peerIdentity.info.cid,
    'reopen-time discovery remains bound to the authenticated selected contact');

  await peer.registerCommands([]);
  await until('removed catalog reaches existing contact', async () => {
    const current = await catalog();
    return current.commands.length === 0 ? current : undefined;
  }, 30_000);

  await peer.releaseLease();
  console.log(`runtime-command-catalog-reopen OK — exact SDK ${candidateSha} propagates existing-contact 0→N→0 to Messenger API reads`);
} finally {
  if (server) await server.close();
  await daemon.close();
  rmSync(appState, { recursive: true, force: true });
}
