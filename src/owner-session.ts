import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { isAbsolute, join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { attachOursClient, OursClient, OwnerTerminalObservation } from '@ours.network/sdk';
import { ConfigurationError } from './security.js';

export interface OwnerSelection {
  endpoint: string;
  expectedInstanceId: string;
  credentialPath: string;
  identity: string;
}
interface SessionRecord {
  version: 1;
  ownerInstanceId: string;
  selection: OwnerSelection;
  phase: 'active' | 'terminal';
  observation?: OwnerTerminalObservation;
}
type Attach = typeof attachOursClient;
// lstat deliberately counts a dangling link as existing unsafe state.
function stateExists(path: string): boolean {
  try { fs.lstatSync(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
const selectionKeys = ['endpoint', 'expectedInstanceId', 'credentialPath', 'identity'] as const;

/** One application-state activation; never a process-death observer. */
export class OwnerSession {
  private record!: SessionRecord;
  private readonly path: string;
  private lockFd: number | undefined;
  private constructor(private readonly stateDir: string, private readonly selection: OwnerSelection) {
    this.path = join(stateDir, 'owner-session.json');
  }

  static async open(stateDir: string, selection: OwnerSelection | undefined, attach: Attach): Promise<OwnerSession | undefined> {
    const saved = stateDir && stateExists(join(stateDir, 'owner-session.json'));
    // Preserve previously supported native/legacy execution without pretending
    // that it can resume state whose activation primitive is unqualified here.
    if (!selection || process.platform !== 'linux') {
      if (saved) throw new ConfigurationError('Saved messenger ownership requires its qualified V1 activation and original selection');
      return undefined;
    }
    if (!stateDir || !isAbsolute(stateDir) || resolve(stateDir) !== stateDir) {
      throw new ConfigurationError('Messenger ownership requires an absolute private state directory');
    }
    // Missing optional utility preserves an unsaved native V1 session. A saved
    // owner must never continue unlocked; all other activation errors still fail.
    const capability = spawnSync('flock', ['--version'], { stdio: 'ignore', timeout: 5000 });
    if ((capability.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' && !saved) return undefined;
    if (capability.error || capability.signal || capability.status !== 0) {
      throw new ConfigurationError('Messenger state locking is unavailable on this runtime');
    }
    const session = new OwnerSession(stateDir, selection);
    try {
      session.activate();
      if (stateExists(session.path)) {
        session.record = session.read();
        if (selectionKeys.some(key => session.record.selection[key] !== selection[key])) {
          throw new ConfigurationError('Saved messenger owner selection differs from the configured daemon or identity');
        }
        if (session.record.phase === 'terminal') {
          const client = await attach(session.clientOptions());
          try { await session.finishTerminal(client); }
          finally { await client.close(); }
        } else return session;
      }
      session.record = { version: 1, ownerInstanceId: 'messenger-' + randomBytes(24).toString('hex'),
        selection: { ...selection }, phase: 'active' };
      session.write();
      return session;
    } catch (error) {
      session.close();
      throw error;
    }
  }

  get ownerInstanceId(): string { return this.record.ownerInstanceId; }
  private clientOptions() {
    const { endpoint, expectedInstanceId, credentialPath } = this.record.selection;
    return { endpoint, expectedInstanceId, credentialPath, leaseToken: this.ownerInstanceId,
      sessionMode: 'external' as const, env: {} };
  }

  /** Called only after the existing server has drained admitted work. */
  async terminate(client: OursClient): Promise<void> {
    if (this.record.phase === 'active') {
      const stat = fs.readFileSync('/proc/self/stat', 'utf8');
      const startId = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
      if (Number(stat.split(' ')[0]) !== process.pid || !/^\d+$/.test(startId ?? '')) {
        throw new Error('Cannot identify current messenger runtime for SessionEnd');
      }
      this.record = { ...this.record, phase: 'terminal', observation: {
        ownerInstanceId: this.ownerInstanceId, reason: 'session-end', observedAt: Date.now(),
        process: { pid: process.pid, startId,
          bootId: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
          domain: fs.readlinkSync('/proc/self/ns/pid') },
      } };
      this.write();
    }
    await this.finishTerminal(client);
  }

  private async finishTerminal(client: OursClient): Promise<void> {
    // This existing public form bounds delivery/body and validates complete ACK.
    const result = await client.releaseLease({ observation: this.record.observation! });
    if (result.failed > 0) throw new Error('messenger owner release incomplete');
    fs.unlinkSync(this.path);
    this.syncDirectory();
  }

  close(): void {
    if (this.lockFd !== undefined) {
      fs.closeSync(this.lockFd);
      this.lockFd = undefined;
    }
  }

  private activate(): void {
    // Check existing ancestry before creating any child application state.
    // Same-user/root ancestry, with the normal root-owned sticky /tmp exception.
    for (let path = this.stateDir; ; path = dirname(path)) {
      let st: fs.Stats | undefined;
      try { st = fs.lstatSync(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (st && (!st.isDirectory() || st.isSymbolicLink() || (st.uid !== 0 && st.uid !== process.getuid!())
        || ((st.mode & 0o022) !== 0 && !(st.uid === 0 && (st.mode & 0o1000) !== 0)))) {
        throw new ConfigurationError('Messenger ownership state requires safe private directory ancestry');
      }
      if (path === dirname(path)) break;
    }
    fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    this.privateStat(this.stateDir, true);
    const path = join(this.stateDir, 'owner-session.lock');
    this.lockFd = fs.openSync(path, fs.constants.O_CREAT | fs.constants.O_RDWR
      | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
    const st = this.privateStat(path);
    const opened = fs.fstatSync(this.lockFd);
    if (st.dev !== opened.dev || st.ino !== opened.ino) throw new Error('Messenger activation file changed');
    const acquired = spawnSync('flock', ['-n', '3'], {
      stdio: ['ignore', 'pipe', 'pipe', this.lockFd], timeout: 5000,
    });
    if (acquired.error || acquired.signal || acquired.status !== 0) {
      throw new ConfigurationError(acquired.status === 1
        ? 'Messenger application state is already active'
        : 'Messenger state locking is unavailable on this runtime');
    }
  }

  private privateStat(path: string, directory = false): fs.Stats {
    const st = fs.lstatSync(path);
    if ((directory ? !st.isDirectory() : !st.isFile()) || st.isSymbolicLink()
      || st.uid !== process.getuid!() || (st.mode & 0o7777) !== (directory ? 0o700 : 0o600)) {
      throw new ConfigurationError('Messenger owner state must be private, regular and owned by this user');
    }
    return st;
  }

  private read(): SessionRecord {
    const st = this.privateStat(this.path);
    if (st.size < 1 || st.size > 16384) throw new Error('Invalid messenger owner record');
    const fd = fs.openSync(this.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const opened = fs.fstatSync(fd);
      if (opened.dev !== st.dev || opened.ino !== st.ino) throw new Error('Messenger owner record changed');
      const value = JSON.parse(fs.readFileSync(fd, 'utf8')) as SessionRecord;
      if (!value || value.version !== 1 || typeof value.ownerInstanceId !== 'string'
        || !/^messenger-[a-f0-9]{48}$/.test(value.ownerInstanceId)
        || !value.selection || selectionKeys.some(key => typeof value.selection[key] !== 'string' || !value.selection[key])
        || (value.phase !== 'active' && value.phase !== 'terminal')
        || (value.phase === 'active' && value.observation !== undefined)
        || (value.phase === 'terminal' && (!value.observation || value.observation.reason !== 'session-end'
          || value.observation.ownerInstanceId !== value.ownerInstanceId))) {
        throw new Error('Invalid messenger owner record');
      }
      return value;
    } finally { fs.closeSync(fd); }
  }

  private write(): void {
    if (stateExists(this.path)) this.privateStat(this.path);
    const temporary = this.path + '.' + randomBytes(12).toString('hex') + '.tmp';
    let fd: number | undefined;
    try {
      fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY
        | fs.constants.O_NOFOLLOW, 0o600);
      fs.writeFileSync(fd, JSON.stringify(this.record) + '\n');
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
      fs.renameSync(temporary, this.path);
      this.syncDirectory();
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(temporary); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }

  private syncDirectory(): void {
    const fd = fs.openSync(this.stateDir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
}
