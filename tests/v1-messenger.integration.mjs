// Built messenger HTTP/SSE + real V1 CLI/SDK and local ADAPT broker.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {attachOursClient} from '@ours.network/sdk';
import {command, sleep, startProcess, stopProcess, unusedPort, waitFor, waitForPort} from './v1-runtime.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const mode = process.argv[2] ?? 'lifecycle';
assert(['lifecycle', 'crash', 'incomplete'].includes(mode));
const cli = join(ROOT, process.env.MESSENGER_V1_DIST ?? 'dist', 'cli.js');
const oursCli = join(ROOT, 'node_modules/@ours.network/daemon/dist/cli.js');
const state = mkdtempSync(join(tmpdir(), 'messenger-v1-'));
const oursState = join(state, 'ours'); mkdirSync(oursState, {mode: 0o700});
const messengerState = join(state, 'messenger');
const clean = {...process.env};
for (const key of Object.keys(clean)) if (key.startsWith('OURS_')) delete clean[key];
const brokerPort = await unusedPort();
const daemonPort = await unusedPort();
const messengerPort = await unusedPort();
const endpoint = `http://127.0.0.1:${daemonPort}`;
const base = `http://127.0.0.1:${messengerPort}`;
const daemonId = randomUUID();
const credentialPath = join(oursState, 'daemon-token');
const configPath = join(state, 'ours.json');
writeFileSync(configPath, JSON.stringify({brokerUrl: `ws://127.0.0.1:${brokerPort}`, port: daemonPort, stateDir: oursState, apiVisibility: 'owner', apiTokenDeliveryFiles: []}), {mode: 0o600});
const oursEnv = {...clean, HOME: state, OURS_CONFIG: configPath, OURS_DAEMON_ID: daemonId};
const messengerEnv = {...clean, HOME: state, OURS_DAEMON_URL: endpoint, OURS_DAEMON_ID: daemonId, OURS_DAEMON_CREDENTIAL_PATH: credentialPath,
 OURS_MESSENGER_IDENTITY: 'MessengerV1', OURS_MESSENGER_STATE_DIR: messengerState,
 OURS_MESSENGER_HOST: '127.0.0.1', OURS_MESSENGER_PORT: String(messengerPort), OURS_MESSENGER_PUBLIC_ORIGIN: base};
const selection = {endpoint, expectedInstanceId: daemonId, credentialPath, sessionMode: 'external', env: {}};
const attach = () => attachOursClient({...selection, leaseToken: randomUUID()});
const defaults = name => ({name, bio: 'Local messenger lifecycle fixture', exposeLocal: false, localAutoAccept: true});
const bindings = () => JSON.parse(readFileSync(join(oursState, 'bindings.json'), 'utf8'));
const owner = () => bindings().externalLeases.find(row => row.identity === 'MessengerV1')?.token;
const cursor = cid => JSON.parse(readFileSync(join(messengerState, 'push.json'), 'utf8')).identities[cid].notificationCursor;
let broker, daemon, messenger, root, creator, sibling, peer, stream, identityCid, siblingCid, rootCid;
let daemonUnavailable = false;
const pass = text => console.log('PASS ' + text);
async function api(path, body) {
 const res = await fetch(base + path, {signal: AbortSignal.timeout(5000), method: body === undefined ? 'GET' : 'POST',
  headers: body === undefined ? {} : {'content-type': 'application/json', origin: base, 'x-ours-messenger-csrf': '1'},
  body: body === undefined ? undefined : JSON.stringify(body)});
 assert.equal(res.status, 200, `Messenger ${path} must return HTTP200`); return res.json();
}
async function startDaemon() {
 daemon = startProcess([oursCli, 'daemon', 'serve'], oursEnv, ROOT);
 await waitFor(async () => {
  const res = await fetch(endpoint + '/selection', {signal: AbortSignal.timeout(1000)});
  return res.ok && (await res.json()).instanceId === daemonId && existsSync(credentialPath);
 }, 'real V1 daemon selection', 180000);
 if (root) await waitFor(async () => (await root.version({startup: true})).startup.phase === 'ready', 'actual daemon restoration', 180000);
}
async function startMessenger() {
 messenger = startProcess([cli, 'serve'], messengerEnv, ROOT);
 let outcome;
 messenger.exited.then(value => {outcome = value;});
 const deadline = Date.now() + 45000;
 while (Date.now() < deadline) {
  if (outcome) throw new Error(`Built messenger exited before healthy (code=${outcome.code}, signal=${outcome.signal}); ${messenger.stderr.slice(-1800)}`);
  try { const health = await api('/api/healthz'); if (health.status === 'ok') {assert.equal(health.identityCid, identityCid); return;} } catch {}
  await sleep(100);
 }
 throw new Error('Built messenger did not become healthy within fixture allowance');
}
async function openEvents() {
 const controller = new AbortController();
 const response = await fetch(base + '/api/events', {signal: controller.signal});
 assert.equal(response.status, 200); assert(response.headers.get('content-type').includes('text/event-stream'));
 const frames = []; let failure; let buffered = ''; const decoder = new TextDecoder();
 const work = (async () => {
  try {
   for await (const chunk of response.body) {
    buffered += decoder.decode(chunk, {stream: true}).replaceAll('\r\n', '\n');
    let index;
    while ((index = buffered.indexOf('\n\n')) >= 0) {
     const frame = buffered.slice(0,index); buffered = buffered.slice(index+2);
     const event = frame.split('\n').find(row => row.startsWith('event: '))?.slice(7);
     const data = frame.split('\n').find(row => row.startsWith('data: '))?.slice(6);
     if (event && data) frames.push({event, data: JSON.parse(data)});
    }
   }
  } catch (error) {if (!controller.signal.aborted) failure = error;}
 })();
 return {frames, check() {if(failure) throw failure;}, async close() {controller.abort(); await work;}};
}
async function exchange(text, peerCid) {
 const before = stream.frames.filter(frame => frame.event === 'message_received').length;
 const previousCursor = cursor(identityCid);
 await peer.sendMessage({contact: identityCid, text});
 const message = await waitFor(async () => (await api('/api/conversations/' + encodeURIComponent(peerCid))).messages.find(row => row.text === text), 'actual messenger canonical history', 45000);
 await waitFor(() => {stream.check(); return stream.frames.filter(frame => frame.event === 'message_received').length > before;}, 'actual messenger SSE notification', 45000);
 await waitFor(() => cursor(identityCid) > previousCursor, 'durable notification cursor advances', 45000);
 assert(!JSON.stringify(stream.frames).includes(text), 'SSE must remain metadata-only');
 return message.wire_id;
}
async function assertPreserved(expectedOwner) {
 assert.equal(owner(), expectedOwner, 'Surviving messenger owner must remain stable');
 assert.equal((await api('/api/identity')).cid, identityCid);
 assert.equal((await sibling.currentIdentity()).cid, siblingCid);
 assert((await root.listIdentities()).some(row => row.name === 'MessengerRoot' && row.cid === rootCid));
}
const watchdog = setTimeout(() => {messenger?.child.kill('SIGKILL'); daemon?.child.kill('SIGKILL'); broker?.child.kill('SIGKILL'); console.error('FAIL bounded messenger fixture watchdog'); process.exit(124);}, 600000);
try {
 broker = startProcess(['/cowork/node_modules/.bin/adapt-broker', '--host', '127.0.0.1', '--port', String(brokerPort), '--test_mode'], clean, ROOT);
 await waitForPort(brokerPort); await startDaemon();
 root = await attach(); await root.createRootIdentity({...defaults('MessengerRoot'), skipIfRootExists: false}); rootCid = (await root.currentIdentity()).cid;
 creator = await attach(); await creator.createIdentity(defaults('MessengerV1')); identityCid = (await creator.currentIdentity()).cid;
 await creator.releaseLease(); await creator.close(); creator = undefined;
 sibling = await attach(); await sibling.createTemporaryIdentity(defaults('MessengerSibling')); siblingCid = (await sibling.currentIdentity()).cid;
 peer = await attach(); await peer.createIdentity(defaults('MessengerPeer')); const peerCid = (await peer.currentIdentity()).cid;
 pass('real V1 daemon, pre-existing permanent messenger identity and independent fixture owners ready');
 await startMessenger();
 const ownerId = owner(); assert(ownerId);
 assert.equal(bindings().externalLeases.find(row => row.identity === 'MessengerV1').sessionMode, 'external');
 const shell = await fetch(base + '/'); assert.equal(shell.status, 200); assert((await shell.text()).includes('id="root"'));
 await assertPreserved(ownerId);
 pass('actual built messenger health/identity/web shell use explicit V1 HTTP ownership');
 if (mode === 'crash') {
  await waitFor(() => cursor(identityCid) !== null, 'fresh messenger notification tip committed');
  stream = await openEvents();
  const invite = await api('/api/invites', {mode: 'public'});
  await peer.addContact({invite: invite.blob});
  await waitFor(async () => (await peer.listContacts()).contacts.some(row => row.name === 'MessengerV1'), 'actual local peer contact', 45000);
  await exchange('message before messenger crash', peerCid);
  await stream.close(); stream = undefined;
  messenger.child.kill('SIGKILL'); assert.equal((await messenger.exited).signal, 'SIGKILL');
  let restarted = false;
  try {await startMessenger(); restarted = true;} catch {}
  const facts = {exactForegroundKilled: true, restarted, oldOwnerStillBound: owner() === ownerId,
   oldOwnerRetired: bindings().retired.includes(ownerId), permanentCidPreserved: (await root.listIdentities()).some(row => row.name === 'MessengerV1' && row.cid === identityCid),
   siblingPreserved: (await sibling.currentIdentity()).cid === siblingCid};
  console.log('MESSENGER_V1_PROCESS_CRASH ' + JSON.stringify(facts));
  assert(restarted && facts.oldOwnerStillBound && !facts.oldOwnerRetired,
   'Ordinary crash restart must resume the nonterminal logical owner without stranding its permanent identity');
  await assertPreserved(ownerId);
  stream = await openEvents();
  await exchange('message after messenger crash', peerCid);
  await stream.close(); stream = undefined;
  pass('actual foreground crash resumes same logical owner/CID and real history/SSE/cursor');
  await stopProcess(messenger); assert.equal((await messenger.exited).code, 0);
  assert(bindings().retired.includes(ownerId)); assert(!owner());
  await startMessenger();
  assert(owner() && owner() !== ownerId, 'A terminally ended logical session must have a fresh successor');
  await assertPreserved(owner());
  pass('terminal SessionEnd after crash recovery retires original owner; normal restart creates a fresh successor');
  console.log('MESSENGER_V1_CONTINUITY_PASS');
 } else if (mode === 'incomplete') {
  await stopProcess(daemon, 'SIGKILL'); daemonUnavailable = true;
  await stopProcess(messenger);
  assert.equal((await messenger.exited).code, 1, 'Built messenger must not exit0 after failed terminal release');
  assert.equal(owner(), ownerId, 'Unavailable daemon leaves original ownership protected');
  assert(!bindings().retired.includes(ownerId));
  pass('built CLI exits1 on daemon-offline SIGTERM release failure; original owner remains protected');
  const terminalPath = join(messengerState, 'owner-session.json');
  assert(existsSync(terminalPath), 'Failed terminal cleanup must leave durable intent for the original owner');
  const terminalBytes = readFileSync(terminalPath, 'utf8');
  await assert.rejects(startMessenger(), /exited before healthy/, 'Pending terminal cleanup cannot admit a fresh runtime while daemon is unavailable');
  assert.equal(readFileSync(terminalPath, 'utf8'), terminalBytes, 'Failed delivery must preserve the original terminal intent unchanged');
  assert.equal(owner(), ownerId); assert(!bindings().retired.includes(ownerId));
  await startDaemon(); daemonUnavailable = false;
  await startMessenger();
  assert(bindings().retired.includes(ownerId), 'Restored daemon must acknowledge original terminal cleanup before fresh admission');
  const successor = owner(); assert(successor && successor !== ownerId);
  await assertPreserved(successor);
  pass('persisted terminal intent survives failed offline restart and retires exact original owner before fresh admission');
  console.log('MESSENGER_V1_INCOMPLETE_CLEANUP_RECOVERY_PASS');
 } else {
  await waitFor(() => cursor(identityCid) !== null, 'fresh messenger notification tip committed');
  stream = await openEvents();
  await waitFor(() => stream.frames.some(frame => frame.event === 'sync_required' && frame.data.reason === 'connected'), 'actual SSE connected metadata');
  const invite = await api('/api/invites', {mode: 'public'});
  await peer.addContact({invite: invite.blob});
  await waitFor(async () => (await peer.listContacts()).contacts.some(row => row.name === 'MessengerV1'), 'actual local peer contact', 45000);
  const firstWire = await exchange('message before daemon restart', peerCid);
  pass('actual local message appears in HTTP history and metadata SSE with a committed byte cursor');
  const boot = (await root.version({startup: true})).startup.bootId;
  await stopProcess(daemon, 'SIGKILL');
  await waitFor(() => stream.frames.some(frame => frame.data.reason === 'daemon_unavailable'), 'SSE signals daemon interruption', 45000);
  await startDaemon(); assert.notEqual((await root.version({startup: true})).startup.bootId, boot);
  await waitFor(() => stream.frames.some(frame => frame.data.reason === 'daemon_reconnected'), 'SSE signals actual daemon reconnection', 45000);
  await assertPreserved(ownerId);
  await exchange('message after daemon restart', peerCid);
  pass('actual daemon restart preserves messenger owner/CID and resumes history/SSE/cursor');
  const oldToken = readFileSync(credentialPath, 'utf8').trim();
  await command([oursCli, 'config', 'token-update', '--config', configPath, '--json'], oursEnv, ROOT);
  assert(readFileSync(credentialPath, 'utf8').trim() !== oldToken);
  assert.equal((await fetch(endpoint + '/version', {headers: {'x-ours-api-token': oldToken}})).status, 401);
  await exchange('message after common token update', peerCid);
  // The first response could finish a poll authorized before replacement.
  // A second sequential notification requires the next current-file request.
  await exchange('message on next current-token poll', peerCid);
  await assertPreserved(ownerId);
  pass('official token update rejects stale credential while same messenger owner resumes current-file notifications');
  await stream.close(); stream = undefined;
  await stopProcess(messenger); assert.equal((await messenger.exited).code, 0);
  assert(bindings().retired.includes(ownerId)); assert(!owner());
  assert.equal((await sibling.currentIdentity()).cid, siblingCid);
  assert((await root.listIdentities()).some(row => row.name === 'MessengerV1' && row.cid === identityCid));
  pass('normal built CLI shutdown awaits exact owner retirement and preserves permanent identity/sibling');
  const push = await command(['--import','tsx',join(ROOT,'tests/fixtures/v1-push.mjs'),identityCid,peerCid,firstWire], messengerEnv, ROOT, 60000);
  process.stdout.write(push);
  console.log('MESSENGER_V1_INTEGRATION_PASS (local broker/callback only; live push and platforms unproven)');
 }
} catch (error) {console.error(error.stack); process.exitCode = 1;}
finally {
 if (stream) await stream.close();
 try {await stopProcess(messenger);} catch (error) {console.error('Messenger fixture cleanup:', error.message); process.exitCode = 1;}
 for (const client of [peer,sibling,creator,root].filter(Boolean)) {
  try {if (!daemonUnavailable) await client.releaseLease(); await client.close();} catch (error) {console.error('Fixture owner cleanup:', error.message); process.exitCode = 1;}
 }
 try {await stopProcess(daemon);} catch (error) {console.error('Daemon cleanup:',error.message); process.exitCode = 1;}
 await stopProcess(broker,'SIGKILL'); rmSync(state,{recursive:true,force:true}); clearTimeout(watchdog);
}
