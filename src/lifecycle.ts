import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync,
  renameSync, rmdirSync, statSync, writeFileSync, closeSync, fsyncSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { MessengerConfig } from './config.js';
import { tryAcquireOwnedRuntimeAdvisoryLock, type AdvisoryLockProbe } from './boot-env.js';

export const INITIALIZATION_RECEIPT = 'initialization.json';
export const MIGRATION_RECEIPT = 'migration.json';

export class InitializationRequiredError extends Error {
  readonly code = 'INITIALIZATION_REQUIRED';

  constructor(readonly stateDir: string) {
    super(
      `messenger state at ${stateDir} has no identity; run the offline init command before serve`,
    );
    this.name = 'InitializationRequiredError';
  }
}

export interface InitializationReceipt {
  readonly version: 1;
  readonly kind: 'ours-messenger-human-root';
  readonly createdAt: string;
  readonly stateDir: string;
  readonly runtimeStateDir: string;
  readonly identity: {
    readonly name: string;
    readonly cid: string;
    readonly bio: string;
    readonly hierarchy: 'root';
  };
}

interface OfflineRuntime {
  readonly client: {
    listIdentities(): Promise<Array<{ name: string; cid: string; kind?: string }>>;
    createRootIdentity(args: {
      name: string; bio: string; exposeLocal: boolean; localAutoAccept: boolean; skipIfRootExists: boolean;
    }): Promise<{ info: { name: string; cid: string; bio?: string }; hierarchy: string }>;
    releaseLease?(): Promise<unknown>;
  };
  close(): Promise<void>;
}

interface InitDeps {
  startRuntime(cfg: MessengerConfig, buildInfo: { name: string; version: string }): Promise<OfflineRuntime>;
  now?: () => Date;
  buildInfo?: { name: string; version: string };
}

function requireNonEmpty(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be non-empty`);
  return value.trim();
}

function atomicPrivateJson(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

export function readInitializationReceipt(stateDir: string): InitializationReceipt | null {
  const resolvedStateDir = resolve(stateDir);
  const path = join(resolvedStateDir, INITIALIZATION_RECEIPT);
  if (!existsSync(path)) return null;
  let parsed: InitializationReceipt;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as InitializationReceipt;
  } catch (error) {
    throw new Error(`invalid initialization provenance at ${path}: ${(error as Error).message}`);
  }
  if (
    parsed.version !== 1 || parsed.kind !== 'ours-messenger-human-root' ||
    !parsed.identity?.name || !parsed.identity?.cid || parsed.identity.hierarchy !== 'root' ||
    resolve(parsed.stateDir) !== resolvedStateDir || resolve(parsed.runtimeStateDir) !== join(resolvedStateDir, 'runtime')
  ) {
    throw new Error(`invalid initialization provenance at ${path}: required fields or state path do not match`);
  }
  return parsed;
}

function persistedIdentityNames(runtimeDir: string): string[] {
  if (!existsSync(runtimeDir)) return [];
  return readdirSync(runtimeDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) =>
      existsSync(join(runtimeDir, entry.name, 'identity.key')) &&
      existsSync(join(runtimeDir, entry.name, 'state_data.bin')),
    )
    .map((entry) => entry.name)
    .sort();
}

/** Read-only preflight: an empty serve fails before lock/config/token creation. */
export function assertStateInitializedForServe(cfg: MessengerConfig): void {
  readInitializationReceipt(cfg.stateDir); // present-but-invalid provenance fails closed
  if (persistedIdentityNames(join(resolve(cfg.stateDir), 'runtime')).length === 0) {
    throw new InitializationRequiredError(resolve(cfg.stateDir));
  }
}

export async function initializeMessengerState(
  cfg: MessengerConfig,
  input: { name: string; bio: string; confirmed: boolean },
  deps: InitDeps,
): Promise<InitializationReceipt> {
  const name = requireNonEmpty(input.name, 'Human identity name');
  const bio = requireNonEmpty(input.bio, 'Human identity bio');
  if (!input.confirmed) throw new Error('initialization requires explicit confirmation (or --yes)');
  if (cfg.identity !== name) throw new Error('initialization identity must exactly match the configured messenger identity');

  const stateDir = resolve(cfg.stateDir);
  const runtimeStateDir = join(stateDir, 'runtime');
  const receiptPath = join(stateDir, INITIALIZATION_RECEIPT);
  if (existsSync(receiptPath)) throw new Error(`messenger state is already initialized at ${stateDir}`);
  const artifacts = existsSync(runtimeStateDir)
    ? readdirSync(runtimeStateDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .filter((entry) =>
        existsSync(join(runtimeStateDir, entry.name, 'identity.key')) ||
        existsSync(join(runtimeStateDir, entry.name, 'state_data.bin')),
      )
      .map((entry) => entry.name)
      .sort()
    : [];
  if (artifacts.length !== 0) {
    throw new Error(`messenger state already contains identity artifacts (${artifacts.join(', ')}); refusing initialization`);
  }

  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);

  const runtime = await deps.startRuntime(
    cfg,
    deps.buildInfo ?? { name: '@ours.network/messenger-server', version: 'offline-init' },
  );
  try {
    const before = await runtime.client.listIdentities();
    if (before.length !== 0) throw new Error('messenger runtime is non-empty; refusing initialization without mutation');

    const created = await runtime.client.createRootIdentity({
      name,
      bio,
      exposeLocal: true,
      localAutoAccept: true,
      skipIfRootExists: false,
    });
    if (created.hierarchy !== 'root' || created.info.name !== name || !created.info.cid) {
      throw new Error('root initialization did not return the requested Human/root identity; refusing to attest it');
    }
    const after = await runtime.client.listIdentities();
    if (after.length !== 1 || after[0]?.name !== name || after[0]?.cid !== created.info.cid || after[0]?.kind !== 'root') {
      throw new Error('root initialization verification failed: expected exactly one matching Human/root identity');
    }

    const receipt: InitializationReceipt = {
      version: 1,
      kind: 'ours-messenger-human-root',
      createdAt: (deps.now?.() ?? new Date()).toISOString(),
      stateDir,
      runtimeStateDir,
      identity: { name, cid: created.info.cid, bio, hierarchy: 'root' },
    };
    atomicPrivateJson(receiptPath, receipt);
    return receipt;
  } finally {
    try { await runtime.client.releaseLease?.(); } finally { await runtime.close(); }
  }
}

export interface StateManifest {
  readonly digest: string;
  readonly files: number;
  readonly bytes: number;
  readonly identityNames: readonly string[];
  readonly historyFiles: number;
  readonly receiptFiles: number;
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel);
}

function assertSeparatePaths(paths: Array<[string, string]>): void {
  for (let i = 0; i < paths.length; i++) {
    for (let j = i + 1; j < paths.length; j++) {
      const [aName, a] = paths[i];
      const [bName, b] = paths[j];
      if (a === b || isInside(a, b) || isInside(b, a)) {
        throw new Error(`${aName} and ${bName} must be distinct, non-nested paths`);
      }
    }
  }
}

function manifest(root: string, pathPrefix = ''): StateManifest {
  const entries: Array<{ path: string; bytes: number; sha256: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`state migration refuses symbolic link ${path}`);
      if (entry.isDirectory()) { walk(path); continue; }
      if (!entry.isFile()) throw new Error(`state migration refuses non-regular file ${path}`);
      const body = readFileSync(path);
      const relativePath = relative(root, path).split('\\').join('/');
      entries.push({
        path: pathPrefix ? `${pathPrefix}/${relativePath}` : relativePath,
        bytes: body.length,
        sha256: createHash('sha256').update(body).digest('hex'),
      });
    }
  };
  walk(root);
  const digest = createHash('sha256');
  for (const entry of entries) digest.update(`${entry.path}\0${entry.bytes}\0${entry.sha256}\n`);
  return {
    digest: digest.digest('hex'),
    files: entries.length,
    bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    identityNames: persistedIdentityNames(root),
    historyFiles: entries.filter((entry) => /(^|\/)history(\/|$)|messages/i.test(entry.path)).length,
    receiptFiles: entries.filter((entry) => /receipt/i.test(entry.path)).length,
  };
}

function manifestLogicalPayload(runtimeDir: string, pushPath: string | null, mediaDir: string | null): StateManifest {
  // Use a streaming entry collector so source paths normalize to the exact
  // destination layout (`runtime/*`, optional `push.json`).
  const entries: Array<{ path: string; bytes: number; sha256: string }> = [];
  const collect = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      const logical = `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`state migration refuses symbolic link ${path}`);
      if (entry.isDirectory()) { collect(path, logical); continue; }
      if (!entry.isFile()) throw new Error(`state migration refuses non-regular file ${path}`);
      const body = readFileSync(path);
      entries.push({ path: logical, bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') });
    }
  };
  collect(runtimeDir, 'runtime');
  if (pushPath) {
    const st = lstatFile(pushPath);
    if (!st.isFile()) throw new Error(`state migration refuses non-regular push state ${pushPath}`);
    const body = readFileSync(pushPath);
    entries.push({ path: 'push.json', bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') });
  }
  if (mediaDir) collect(mediaDir, 'media');
  entries.sort((a, b) => a.path.localeCompare(b.path));
  const digest = createHash('sha256');
  for (const entry of entries) digest.update(`${entry.path}\0${entry.bytes}\0${entry.sha256}\n`);
  return {
    digest: digest.digest('hex'),
    files: entries.length,
    bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    identityNames: persistedIdentityNames(runtimeDir),
    historyFiles: entries.filter((entry) => /(^|\/)history(\/|$)|messages/i.test(entry.path)).length,
    receiptFiles: entries.filter((entry) => /receipt/i.test(entry.path)).length,
  };
}

function lstatFile(path: string): NonNullable<ReturnType<typeof statSync>> {
  const st = lstatSync(path);
  if (!st || st.isSymbolicLink()) throw new Error(`state migration refuses symbolic link ${path}`);
  return st;
}

function enforcePrivateTree(root: string): void {
  chmodSync(root, 0o700);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) enforcePrivateTree(path);
    else chmodSync(path, 0o600);
  }
}

function lockStoppedSource(source: string): AdvisoryLockProbe | null {
  const lockPath = join(source, '.messenger-runtime.lock');
  const probe = existsSync(lockPath) ? tryAcquireOwnedRuntimeAdvisoryLock(lockPath) : null;
  if (existsSync(lockPath) && !probe) {
    throw new Error(`source runtime is live/locked at ${source}; stop it before migration`);
  }
  const managedPath = join(source, 'ours-cli-daemon.json');
  if (!existsSync(managedPath)) return probe;
  const record = (() => {
    try { return JSON.parse(readFileSync(managedPath, 'utf8')) as { pid?: unknown; stateDir?: unknown }; }
    catch { return null; }
  })();
  if (!record || !Number.isInteger(record.pid) || Number(record.pid) <= 1 || resolve(String(record.stateDir ?? '')) !== source) return probe;
  try {
    process.kill(Number(record.pid), 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return probe;
    probe?.close();
    throw new Error(`cannot prove managed source pid ${String(record.pid)} is stopped; refusing migration`);
  }
  probe?.close();
  throw new Error(`source runtime has a live managed daemon pid ${String(record.pid)}; stop it before migration`);
}

export interface MigrationReceipt {
  readonly version: 1;
  readonly kind: 'ours-messenger-offline-migration';
  readonly createdAt: string;
  readonly source: string;
  readonly sourceKind: 'sdk-runtime' | 'messenger-root';
  readonly sourceRuntimeDir: string;
  readonly destinationStateDir: string;
  readonly destinationRuntimeDir: string;
  readonly backupDir: string;
  readonly sourceManifest: StateManifest;
  readonly destinationManifest: StateManifest;
}

export function migrateMessengerState(input: {
  source: string;
  destinationStateDir: string;
  backupDir: string;
  confirmed: boolean;
  now?: () => Date;
}): MigrationReceipt {
  if (!input.confirmed) throw new Error('migration requires explicit confirmation (or --yes)');
  const source = resolve(requireNonEmpty(input.source, 'migration source'));
  const destinationStateDir = resolve(requireNonEmpty(input.destinationStateDir, 'migration destination'));
  const backupDir = resolve(requireNonEmpty(input.backupDir, 'migration backup'));
  assertSeparatePaths([['source', source], ['destination', destinationStateDir], ['backup', backupDir]]);

  if (!existsSync(source) || !statSync(source).isDirectory()) throw new Error(`migration source is not a directory: ${source}`);
  if (readdirSync(source).length === 0) throw new Error(`migration source is empty: ${source}`);
  const directIdentities = persistedIdentityNames(source);
  const nestedRuntime = join(source, 'runtime');
  const nestedIdentities = persistedIdentityNames(nestedRuntime);
  if (directIdentities.length !== 0 && nestedIdentities.length !== 0) {
    throw new Error(`migration source is ambiguous: identities exist both at ${source} and ${nestedRuntime}`);
  }
  const sourceKind = nestedIdentities.length !== 0 ? 'messenger-root' : 'sdk-runtime';
  const sourceRuntimeDir = sourceKind === 'messenger-root' ? nestedRuntime : source;
  const identities = sourceKind === 'messenger-root' ? nestedIdentities : directIdentities;
  if (identities.length === 0) throw new Error(`migration source has no complete persisted identity: ${source}`);
  if (existsSync(backupDir)) throw new Error(`migration backup already exists: ${backupDir}`);
  if (existsSync(destinationStateDir) && !statSync(destinationStateDir).isDirectory()) {
    throw new Error(`migration destination is not a directory: ${destinationStateDir}`);
  }
  if (existsSync(destinationStateDir) && readdirSync(destinationStateDir).length !== 0) {
    throw new Error(`migration destination is non-empty: ${destinationStateDir}`);
  }
  const sourceLock = lockStoppedSource(sourceRuntimeDir);
  try {
    // Validate every source entry and freeze the source-side verification facts
    // before creating either the backup or destination.
    manifest(source); // rejects links/special files anywhere in the explicit backup source
    const sourcePushPath = sourceKind === 'messenger-root' && existsSync(join(source, 'push.json'))
      ? join(source, 'push.json')
      : null;
    const sourceMediaDir = sourceKind === 'messenger-root' && existsSync(join(source, 'media'))
      ? join(source, 'media')
      : null;
    if (sourceMediaDir && !lstatFile(sourceMediaDir).isDirectory()) {
      throw new Error(`state migration refuses non-directory media state ${sourceMediaDir}`);
    }
    const sourceManifest = manifestLogicalPayload(sourceRuntimeDir, sourcePushPath, sourceMediaDir);

    // All invalid-input checks above are deliberately mutation-free. From here on
    // the explicit backup is created before the destination is populated.
    mkdirSync(backupDir, { recursive: false, mode: 0o700 });
    cpSync(source, join(backupDir, 'source'), { recursive: true, preserveTimestamps: true, errorOnExist: true });
    mkdirSync(join(backupDir, 'destination'), { mode: 0o700 });
    enforcePrivateTree(backupDir);

    mkdirSync(dirname(destinationStateDir), { recursive: true, mode: 0o700 });
    const stage = `${destinationStateDir}.migration-${process.pid}-${randomBytes(6).toString('hex')}`;
    const destinationRuntimeDir = join(destinationStateDir, 'runtime');
    mkdirSync(stage, { mode: 0o700 });
    cpSync(sourceRuntimeDir, join(stage, 'runtime'), { recursive: true, preserveTimestamps: true, errorOnExist: true });
    if (sourcePushPath) cpSync(sourcePushPath, join(stage, 'push.json'), { preserveTimestamps: true, errorOnExist: true });
    if (sourceMediaDir) cpSync(sourceMediaDir, join(stage, 'media'), { recursive: true, preserveTimestamps: true, errorOnExist: true });
    enforcePrivateTree(stage);

    const destinationManifest = manifestLogicalPayload(
      join(stage, 'runtime'),
      existsSync(join(stage, 'push.json')) ? join(stage, 'push.json') : null,
      existsSync(join(stage, 'media')) ? join(stage, 'media') : null,
    );
    if (sourceManifest.digest !== destinationManifest.digest || sourceManifest.files !== destinationManifest.files) {
      throw new Error('migration verification failed: destination manifest does not match source');
    }
    if (existsSync(destinationStateDir)) rmdirSync(destinationStateDir);
    renameSync(stage, destinationStateDir);
    chmodSync(destinationStateDir, 0o700);

    const receipt: MigrationReceipt = {
      version: 1,
      kind: 'ours-messenger-offline-migration',
      createdAt: (input.now?.() ?? new Date()).toISOString(),
      source,
      sourceKind,
      sourceRuntimeDir,
      destinationStateDir,
      destinationRuntimeDir,
      backupDir,
      sourceManifest,
      destinationManifest,
    };
    atomicPrivateJson(join(destinationStateDir, MIGRATION_RECEIPT), receipt);
    return receipt;
  } finally {
    sourceLock?.close();
  }
}
