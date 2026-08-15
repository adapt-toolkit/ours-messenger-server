// Web Push state belongs to this messenger server. It is identity-scoped,
// owner-only, and never exposed through REST: endpoints and subscription keys are
// bearer capabilities even though Web Push encrypts each payload for the browser.

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import webpush from 'web-push';

export type PushPreviewMode = 'full' | 'private';
export type PushKind = 'message' | 'file' | 'photo' | 'voice';

export interface PushSubscriptionRecord {
  readonly bindingId: string;
  readonly endpoint: string;
  readonly keys: { readonly p256dh: string; readonly auth: string };
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly vapidFingerprint: string;
  readonly configEpoch: number;
  readonly preview: PushPreviewMode;
  readonly label?: string;
}

export interface PushEvent {
  readonly v: 1;
  readonly kind: PushKind;
  readonly title: string;
  readonly body: string;
  readonly contact_id: string;
  readonly wire_id: string;
  readonly url: string;
}

export interface PushJob {
  readonly id: string;
  readonly identityCid: string;
  readonly wireId: string;
  readonly kind: PushKind;
  readonly contactId: string;
  readonly senderName?: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly attempts: number;
  readonly nextAttemptAt: number;
  readonly targetBindingIds: string[];
  readonly deliveredBindingIds: string[];
  readonly status: 'pending' | 'sent' | 'dropped';
  readonly sentCount: number;
  readonly completedAt?: number;
}

interface VapidKeys {
  publicKey: string;
  privateKey: string;
  subject: string;
}

interface IdentityPushState {
  bindings: PushSubscriptionRecord[];
  jobs: PushJob[];
}

interface PushStateV2 {
  version: 2;
  vapid: VapidKeys;
  vapidFingerprint: string;
  configEpoch: number;
  identities: Record<string, IdentityPushState>;
}

interface LegacyPushState {
  vapid: VapidKeys;
  subscriptions: Array<{
    endpoint: string;
    keys: { p256dh: string; auth: string };
    createdAt: string;
    label?: string;
  }>;
}

export interface PushStoreDependencies {
  readonly sendNotification?: (
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
    payload: string,
    options: { vapidDetails: VapidKeys },
  ) => Promise<unknown>;
}

const MAX_BINDINGS = 32;
const MAX_ENDPOINT_LENGTH = 2_048;
const MAX_LABEL_LENGTH = 160;
const MAX_JOBS_PER_IDENTITY = 4_096;
const JOB_EXPIRY_MS = 24 * 60 * 60 * 1_000;
const TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_ATTEMPTS = 6;

function nonEmpty(value: unknown, max = Number.MAX_SAFE_INTEGER): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function fingerprint(publicKey: string): string {
  return createHash('sha256').update(publicKey).digest('base64url');
}

function base64urlBytes(value: unknown, length: number, field: string): string {
  if (!nonEmpty(value, 256) || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`push subscription ${field} must be canonical base64url`);
  }
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== length || bytes.toString('base64url') !== value) {
    throw new Error(`push subscription ${field} has an invalid decoded length`);
  }
  return value;
}

function endpointUrl(value: unknown): string {
  if (!nonEmpty(value, MAX_ENDPOINT_LENGTH)) throw new Error('push subscription endpoint is missing or too long');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('push subscription endpoint must be a valid HTTPS URL');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) {
    throw new Error('push subscription endpoint must be credential-free HTTPS without a fragment');
  }
  return value;
}

function previewMode(value: unknown): PushPreviewMode {
  if (value === undefined) return 'full';
  if (value !== 'full' && value !== 'private') throw new Error('push subscription preview must be full or private');
  return value;
}

function validBinding(value: unknown): value is PushSubscriptionRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Partial<PushSubscriptionRecord>;
  try {
    endpointUrl(row.endpoint);
    base64urlBytes(row.keys?.p256dh, 65, 'p256dh');
    base64urlBytes(row.keys?.auth, 16, 'auth');
    previewMode(row.preview);
  } catch {
    return false;
  }
  return nonEmpty(row.bindingId, 128) && nonEmpty(row.createdAt, 64) && nonEmpty(row.updatedAt, 64)
    && nonEmpty(row.vapidFingerprint, 128) && Number.isSafeInteger(row.configEpoch) && row.configEpoch! > 0
    && (row.label === undefined || nonEmpty(row.label, MAX_LABEL_LENGTH));
}

function validJob(value: unknown): value is PushJob {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Partial<PushJob>;
  return nonEmpty(row.id, 2_048) && nonEmpty(row.identityCid, 512) && nonEmpty(row.wireId, 1_024)
    && (row.kind === 'message' || row.kind === 'file' || row.kind === 'photo' || row.kind === 'voice')
    && nonEmpty(row.contactId, 512) && (row.senderName === undefined || nonEmpty(row.senderName, 512))
    && Number.isFinite(row.createdAt) && Number.isFinite(row.expiresAt) && Number.isSafeInteger(row.attempts)
    && row.attempts! >= 0 && Number.isFinite(row.nextAttemptAt) && Array.isArray(row.targetBindingIds)
    && row.targetBindingIds.length <= MAX_BINDINGS
    && row.targetBindingIds.every((id) => nonEmpty(id, 128)) && Array.isArray(row.deliveredBindingIds)
    && row.deliveredBindingIds.length <= MAX_BINDINGS
    && row.deliveredBindingIds.every((id) => nonEmpty(id, 128))
    && (row.status === 'pending' || row.status === 'sent' || row.status === 'dropped')
    && Number.isSafeInteger(row.sentCount) && row.sentCount! >= 0
    && (row.completedAt === undefined || Number.isFinite(row.completedAt));
}

function validVapid(value: unknown): value is VapidKeys {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const vapid = value as Partial<VapidKeys>;
  try {
    base64urlBytes(vapid.publicKey, 65, 'VAPID public key');
    base64urlBytes(vapid.privateKey, 32, 'VAPID private key');
    if (!nonEmpty(vapid.subject, 2_048)) return false;
    const subject = new URL(vapid.subject);
    return subject.protocol === 'mailto:' || subject.protocol === 'https:';
  } catch {
    return false;
  }
}

function validV2(value: unknown): value is PushStateV2 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as Partial<PushStateV2>;
  if (state.version !== 2 || !validVapid(state.vapid) || !nonEmpty(state.vapidFingerprint, 128)
    || !Number.isSafeInteger(state.configEpoch) || state.configEpoch! < 1
    || !state.identities || typeof state.identities !== 'object' || Array.isArray(state.identities)) return false;
  return Object.entries(state.identities).every(([cid, identity]) => nonEmpty(cid, 512)
    && !!identity && typeof identity === 'object'
    && Array.isArray(identity.bindings) && identity.bindings.length <= MAX_BINDINGS && identity.bindings.every(validBinding)
    && Array.isArray(identity.jobs) && identity.jobs.length <= MAX_JOBS_PER_IDENTITY
    && identity.jobs.every((job) => validJob(job) && job.identityCid === cid));
}

function validLegacy(value: unknown): value is LegacyPushState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as Partial<LegacyPushState>;
  return validVapid(state.vapid) && Array.isArray(state.subscriptions) && state.subscriptions.length <= MAX_BINDINGS
    && state.subscriptions.every((row) => {
      try {
        endpointUrl(row?.endpoint);
        base64urlBytes(row?.keys?.p256dh, 65, 'p256dh');
        base64urlBytes(row?.keys?.auth, 16, 'auth');
      } catch {
        return false;
      }
      return nonEmpty(row.createdAt, 64) && (row.label === undefined || nonEmpty(row.label, MAX_LABEL_LENGTH));
    });
}

function preservedStateError(file: string, reason: string): Error {
  return new Error(
    `Existing push state ${file} is ${reason}; it was left unchanged. `
      + 'Restore valid push.json contents, or move the file aside explicitly before restarting.',
  );
}

function identityState(state: PushStateV2, cid: string): IdentityPushState {
  return state.identities[cid] ??= { bindings: [], jobs: [] };
}

function privateEvent(event: PushEvent): PushEvent {
  const body = event.kind === 'message' ? 'New message'
    : event.kind === 'voice' ? 'New voice message'
      : event.kind === 'photo' ? 'New photo' : 'New file';
  return { ...event, title: 'ours messenger', body };
}

const LEGACY_LOCAL_VAPID_SUBJECT = 'mailto:admin@localhost';
const DEFAULT_VAPID_SUBJECT = 'https://ours.network';

function defaultVapidSubject(env: NodeJS.ProcessEnv): string {
  const configuredOrigin = env.OURS_MESSENGER_PUBLIC_ORIGIN;
  if (configuredOrigin) {
    try {
      const origin = new URL(configuredOrigin);
      if (origin.protocol === 'https:' && origin.hostname && origin.hostname !== 'localhost') return origin.origin;
    } catch {
      // Public-origin validation belongs to the server config. Push still needs
      // a provider-compatible contact URI when the store is opened in isolation.
    }
  }
  return DEFAULT_VAPID_SUBJECT;
}

export class PushStore {
  private readonly file: string;
  private readonly identityCid: string;
  private readonly sendNotification: NonNullable<PushStoreDependencies['sendNotification']>;
  private state: PushStateV2;

  private constructor(file: string, identityCid: string, state: PushStateV2, dependencies: PushStoreDependencies) {
    this.file = file;
    this.identityCid = identityCid;
    this.state = state;
    this.sendNotification = dependencies.sendNotification ?? ((subscription, payload, options) =>
      webpush.sendNotification(subscription, payload, options));
  }

  static open(
    stateDir: string,
    identityCidOrEnv: string | NodeJS.ProcessEnv = process.env,
    envOrDependencies: NodeJS.ProcessEnv | PushStoreDependencies = process.env,
    dependencies: PushStoreDependencies = {},
  ): PushStore {
    const identityCid = typeof identityCidOrEnv === 'string' ? identityCidOrEnv : 'legacy-default';
    const env = typeof identityCidOrEnv === 'string' ? envOrDependencies as NodeJS.ProcessEnv : identityCidOrEnv;
    const deps = typeof identityCidOrEnv === 'string' ? dependencies : envOrDependencies as PushStoreDependencies;
    if (!nonEmpty(identityCid, 512)) throw new Error('push identity CID must be a non-empty bounded string');

    const file = join(stateDir, 'push.json');
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    let parsed: PushStateV2 | LegacyPushState | undefined;
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw preservedStateError(file, 'not a safe regular file');
      let value: unknown;
      try {
        value = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      } catch (error) {
        throw preservedStateError(file, `corrupt or unreadable (${error instanceof Error ? error.message : String(error)})`);
      }
      if (validV2(value) || validLegacy(value)) parsed = value;
      else throw preservedStateError(file, 'schema-invalid');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const storedSubject = parsed?.vapid.subject;
    const subject = env.OURS_MESSENGER_VAPID_SUBJECT
      ?? (storedSubject && storedSubject !== LEGACY_LOCAL_VAPID_SUBJECT
        ? storedSubject : defaultVapidSubject(env));
    const envPublic = env.OURS_MESSENGER_VAPID_PUBLIC_KEY;
    const envPrivate = env.OURS_MESSENGER_VAPID_PRIVATE_KEY;
    if ((envPublic === undefined) !== (envPrivate === undefined)) {
      throw new Error('OURS_MESSENGER_VAPID_PUBLIC_KEY and OURS_MESSENGER_VAPID_PRIVATE_KEY must be set together or not at all.');
    }
    const selected = envPublic && envPrivate
      ? { publicKey: envPublic, privateKey: envPrivate, subject }
      : parsed?.vapid
        ? { ...parsed.vapid, subject }
        : { ...webpush.generateVAPIDKeys(), subject };
    if (!validVapid(selected)) {
      throw new Error('Web Push VAPID keys or subject are invalid; use a canonical P-256 key pair and an HTTPS or mailto subject.');
    }
    const selectedFingerprint = fingerprint(selected.publicKey);

    let state: PushStateV2;
    if (parsed && validV2(parsed)) {
      const rotated = parsed.vapidFingerprint !== selectedFingerprint;
      state = {
        ...parsed,
        vapid: selected,
        vapidFingerprint: selectedFingerprint,
        configEpoch: rotated ? parsed.configEpoch + 1 : parsed.configEpoch,
      };
    } else {
      const oldFingerprint = parsed ? fingerprint(parsed.vapid.publicKey) : selectedFingerprint;
      const now = new Date().toISOString();
      state = {
        version: 2,
        vapid: selected,
        vapidFingerprint: selectedFingerprint,
        configEpoch: 1,
        identities: {
          [identityCid]: {
            bindings: (parsed?.subscriptions ?? []).map((row) => ({
              bindingId: randomUUID(), endpoint: row.endpoint, keys: row.keys,
              createdAt: row.createdAt, updatedAt: now, label: row.label,
              vapidFingerprint: oldFingerprint, configEpoch: 1, preview: 'full',
            })),
            jobs: [],
          },
        },
      };
    }

    const store = new PushStore(file, identityCid, state, deps);
    store.pruneTerminal(Date.now());
    store.persist();
    return store;
  }

  private persist(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
    chmodSync(this.file, 0o600);
  }

  get publicKey(): string { return this.state.vapid.publicKey; }
  get publicConfig(): { publicKey: string; fingerprint: string; configEpoch: number } {
    return { publicKey: this.publicKey, fingerprint: this.state.vapidFingerprint, configEpoch: this.state.configEpoch };
  }
  get bindingCount(): number { return this.list().length; }

  list(): readonly PushSubscriptionRecord[] {
    return identityState(this.state, this.identityCid).bindings.filter((row) =>
      row.vapidFingerprint === this.state.vapidFingerprint && row.configEpoch === this.state.configEpoch);
  }

  hasBindings(): boolean { return this.bindingCount > 0; }

  matchesCredential(endpoint: unknown, auth: unknown): boolean {
    return this.bindingForCredential(endpoint, auth) !== null;
  }

  bindingForCredential(endpoint: unknown, auth: unknown): string | null {
    if (!nonEmpty(endpoint, MAX_ENDPOINT_LENGTH) || !nonEmpty(auth, 256)) return null;
    let candidate: Buffer;
    try { candidate = Buffer.from(auth, 'base64url'); } catch { return null; }
    if (candidate.length !== 16 || candidate.toString('base64url') !== auth) return null;
    const binding = this.list().find((row) => {
      if (row.endpoint !== endpoint) return false;
      const expected = Buffer.from(row.keys.auth, 'base64url');
      return expected.length === candidate.length && timingSafeEqual(expected, candidate);
    });
    return binding?.bindingId ?? null;
  }

  ensure(input: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
    label?: string;
    preview?: PushPreviewMode;
    bindingId?: string;
  }): { bindingId: string; createdAt: string; fingerprint: string; configEpoch: number; preview: PushPreviewMode } {
    const endpoint = endpointUrl(input.endpoint);
    const p256dh = base64urlBytes(input.keys?.p256dh, 65, 'p256dh');
    const auth = base64urlBytes(input.keys?.auth, 16, 'auth');
    if (input.label !== undefined && (!nonEmpty(input.label, MAX_LABEL_LENGTH) || /[\u0000-\u001f\u007f]/.test(input.label))) {
      throw new Error(`push subscription label must be at most ${MAX_LABEL_LENGTH} safe characters`);
    }
    const owner = identityState(this.state, this.identityCid);
    const previous = owner.bindings.find((row) => row.endpoint === endpoint)
      ?? (input.bindingId ? owner.bindings.find((row) => row.bindingId === input.bindingId) : undefined);
    const preview = input.preview === undefined ? previous?.preview ?? 'full' : previewMode(input.preview);
    if (!previous && owner.bindings.length >= MAX_BINDINGS) throw new Error(`push subscription limit is ${MAX_BINDINGS}`);
    const createdAt = previous?.createdAt ?? new Date().toISOString();
    const bindingId = previous?.bindingId ?? randomUUID();
    const record: PushSubscriptionRecord = {
      bindingId, endpoint, keys: { p256dh, auth }, label: input.label,
      createdAt, updatedAt: new Date().toISOString(), preview,
      vapidFingerprint: this.state.vapidFingerprint, configEpoch: this.state.configEpoch,
    };
    owner.bindings = owner.bindings.filter((row) => row.bindingId !== bindingId && row.endpoint !== endpoint);
    owner.bindings.push(record);
    this.persist();
    return { bindingId, createdAt, fingerprint: record.vapidFingerprint, configEpoch: record.configEpoch, preview };
  }

  delete(bindingId: string): boolean {
    if (!nonEmpty(bindingId, 128)) return false;
    const owner = identityState(this.state, this.identityCid);
    const before = owner.bindings.length;
    owner.bindings = owner.bindings.filter((row) => row.bindingId !== bindingId);
    const removed = owner.bindings.length !== before;
    if (removed) this.persist();
    return removed;
  }

  /** Compatibility for old callers; new REST deletes only by opaque binding id. */
  unsubscribe(endpoint: string): boolean {
    const owner = identityState(this.state, this.identityCid);
    const before = owner.bindings.length;
    owner.bindings = owner.bindings.filter((row) => row.endpoint !== endpoint);
    const removed = owner.bindings.length !== before;
    if (removed) this.persist();
    return removed;
  }

  enqueueJob(input: { wireId: string; kind: PushKind; contactId: string; senderName?: string }, now = Date.now()): boolean {
    if (!nonEmpty(input.wireId, 1_024) || !nonEmpty(input.contactId, 512)
      || (input.senderName !== undefined && !nonEmpty(input.senderName, 512))) {
      throw new Error('push job correlation metadata is invalid or too long');
    }
    const targets = this.list().map((row) => row.bindingId);
    if (targets.length === 0) return false;
    const id = `${this.identityCid}:${input.wireId}:${input.kind}`;
    const owner = identityState(this.state, this.identityCid);
    this.pruneTerminal(now);
    if (owner.jobs.some((job) => job.id === id)) return false;
    if (owner.jobs.length >= MAX_JOBS_PER_IDENTITY) return false;
    owner.jobs.push({
      id, identityCid: this.identityCid, wireId: input.wireId, kind: input.kind,
      contactId: input.contactId, senderName: input.senderName,
      createdAt: now, expiresAt: now + JOB_EXPIRY_MS, attempts: 0, nextAttemptAt: now,
      targetBindingIds: targets, deliveredBindingIds: [], status: 'pending', sentCount: 0,
    });
    this.persist();
    return true;
  }

  dueJobs(now = Date.now()): PushJob[] {
    return identityState(this.state, this.identityCid).jobs
      .filter((job) => job.status === 'pending' && job.nextAttemptAt <= now)
      .map((job) => ({ ...job, targetBindingIds: [...job.targetBindingIds], deliveredBindingIds: [...job.deliveredBindingIds] }));
  }

  nextJobDelay(now = Date.now()): number | null {
    const pending = identityState(this.state, this.identityCid).jobs.filter((job) => job.status === 'pending');
    if (pending.length === 0) return null;
    return Math.max(0, Math.min(...pending.map((job) => job.nextAttemptAt)) - now);
  }

  retryJob(jobId: string, now = Date.now(), random: () => number = Math.random): boolean {
    const job = identityState(this.state, this.identityCid).jobs.find((row) => row.id === jobId);
    if (!job || job.status !== 'pending') return false;
    const attempts = job.attempts + 1;
    if (attempts >= MAX_ATTEMPTS || now >= job.expiresAt) {
      Object.assign(job, { attempts, status: 'dropped', completedAt: now });
      this.persist();
      return false;
    }
    const base = Math.min(60_000, 1_000 * (2 ** (attempts - 1)));
    const jitter = Math.floor(base * 0.25 * Math.max(0, Math.min(1, random())));
    Object.assign(job, { attempts, nextAttemptAt: Math.min(job.expiresAt, now + base + jitter) });
    this.persist();
    return true;
  }

  suppressJob(jobId: string, now = Date.now()): boolean {
    const job = identityState(this.state, this.identityCid).jobs.find((row) => row.id === jobId);
    if (!job || job.status !== 'pending') return false;
    Object.assign(job, {
      status: 'sent', completedAt: now, deliveredBindingIds: [...job.targetBindingIds], sentCount: 0,
    });
    this.persist();
    return true;
  }

  suppressBindings(jobId: string, bindingIds: ReadonlySet<string>, now = Date.now()): number {
    const owner = identityState(this.state, this.identityCid);
    const job = owner.jobs.find((row) => row.id === jobId);
    if (!job || job.status !== 'pending' || bindingIds.size === 0) return 0;
    const completed = new Set(job.deliveredBindingIds);
    let suppressed = 0;
    for (const bindingId of job.targetBindingIds) {
      if (bindingIds.has(bindingId) && !completed.has(bindingId)) {
        completed.add(bindingId);
        suppressed++;
      }
    }
    if (suppressed === 0) return 0;
    Object.assign(job, { deliveredBindingIds: [...completed] });
    const outstanding = job.targetBindingIds.some((id) => !completed.has(id)
      && owner.bindings.some((binding) => binding.bindingId === id));
    if (!outstanding) Object.assign(job, { status: 'sent', completedAt: now });
    this.persist();
    return suppressed;
  }

  async dispatchJob(jobId: string, event: PushEvent, now = Date.now(), random: () => number = Math.random): Promise<{
    sent: number; pruned: number; retried: number; dropped: number;
  }> {
    const owner = identityState(this.state, this.identityCid);
    const job = owner.jobs.find((row) => row.id === jobId);
    if (!job || job.status !== 'pending') return { sent: 0, pruned: 0, retried: 0, dropped: 0 };
    const completed = new Set(job.deliveredBindingIds);
    const targets = job.targetBindingIds
      .map((id) => owner.bindings.find((binding) => binding.bindingId === id))
      .filter((binding): binding is PushSubscriptionRecord => !!binding && !completed.has(binding.bindingId)
        && binding.vapidFingerprint === this.state.vapidFingerprint && binding.configEpoch === this.state.configEpoch);
    let sent = 0;
    let pruned = 0;
    let dropped = 0;
    let transient = 0;
    const dead = new Set<string>();
    await Promise.all(targets.map(async (binding) => {
      try {
        const payload = JSON.stringify(binding.preview === 'private' ? privateEvent(event) : event);
        await this.sendNotification(
          { endpoint: binding.endpoint, keys: binding.keys }, payload,
          { vapidDetails: { ...this.state.vapid } },
        );
        completed.add(binding.bindingId);
        sent++;
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          completed.add(binding.bindingId);
          dead.add(binding.bindingId);
          pruned++;
        } else if (status === undefined || status === 429 || status >= 500) {
          transient++;
        } else {
          completed.add(binding.bindingId);
          dropped++;
        }
      }
    }));
    if (dead.size) owner.bindings = owner.bindings.filter((binding) => !dead.has(binding.bindingId));
    Object.assign(job, { deliveredBindingIds: [...completed], sentCount: job.sentCount + sent });
    const outstanding = job.targetBindingIds.some((id) => !completed.has(id) && owner.bindings.some((binding) => binding.bindingId === id));
    if (outstanding && transient) {
      this.persist();
      const retried = this.retryJob(job.id, now, random) ? transient : 0;
      return { sent, pruned, retried, dropped: dropped + (retried ? 0 : transient) };
    }
    Object.assign(job, { status: job.sentCount > 0 ? 'sent' : 'dropped', completedAt: now });
    this.persist();
    return { sent, pruned, retried: 0, dropped };
  }

  queueStats(): { pending: number; sent: number; dropped: number; depth: number } {
    const jobs = identityState(this.state, this.identityCid).jobs;
    return {
      pending: jobs.filter((job) => job.status === 'pending').length,
      sent: jobs.filter((job) => job.status === 'sent').length,
      dropped: jobs.filter((job) => job.status === 'dropped').length,
      depth: jobs.length,
    };
  }

  private pruneTerminal(now: number): void {
    for (const identity of Object.values(this.state.identities)) {
      identity.jobs = identity.jobs.filter((job) => job.status === 'pending'
        || job.completedAt === undefined || now - job.completedAt <= TERMINAL_RETENTION_MS);
    }
  }

  /** Compatibility for tests/old callers; durable production delivery uses jobs. */
  async send(event: PushEvent): Promise<{ sent: number; pruned: number; failed: number; errors: string[] }> {
    const wire = `compat-${randomUUID()}`;
    this.enqueueJob({ wireId: wire, kind: event.kind, contactId: event.contact_id });
    const id = `${this.identityCid}:${wire}:${event.kind}`;
    const result = await this.dispatchJob(id, event);
    return { sent: result.sent, pruned: result.pruned, failed: result.retried + result.dropped, errors: [] };
  }
}
