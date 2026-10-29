import { randomUUID } from 'node:crypto';
import type { OursClient, IdentityResourcePosition } from '@ours.network/sdk';
import { subscribeHumanProfile } from './workspace-profile.js';
import { startResourceObserver, type ResourceObserverHandle } from './watch.js';
import { ACTIVITY_DEADLINE_MS, abortableProjection, canonicalResourceDescriptor, captureResourceProjection, messageProjectionDelta, type ResourceDescriptor, type MessageResourceSnapshot } from './resource-views.js';
import type { ServerResponse } from 'node:http';
import { resourceFrames, RESOURCE_ASSEMBLY_BYTES, RESOURCE_PENDING_BYTES, type ResourceEnvelope, type ResourceCoverage } from './resource-views.js';

interface PendingOutput {
  envelope: ResourceEnvelope | ResourceCoverage;
  bytes: number;
  resolve: () => void;
  reject: (error: Error) => void;
}

/** One Messenger HTTP writer. The active record owns the assembly budget;
 * waiting live records share the smaller pending-output budget. */
export class ResourceOutput {
  readonly #pending: PendingOutput[] = [];
  #pendingBytes = 0;
  #active?: PendingOutput;
  #closed = false;
  #releaseDrain?: () => void;
  readonly #abort = () => this.close();
  constructor(
    readonly response: ServerResponse,
    readonly signal: AbortSignal,
    readonly failed: (error: Error) => void,
  ) {
    if (signal.aborted) this.close();
    else {
      signal.addEventListener('abort', this.#abort, { once: true });
      response.once('close', this.#abort);
    }
  }

  send(envelope: ResourceEnvelope | ResourceCoverage, admitted: () => void = () => {}): Promise<void> {
    if (this.#closed) return Promise.reject(new Error('resource output closed'));
    const bytes = Buffer.byteLength(JSON.stringify(envelope));
    if (bytes > RESOURCE_ASSEMBLY_BYTES) return this.#fail(new Error('resource assembly limit exceeded'));
    if (this.#active && this.#pendingBytes + bytes > RESOURCE_PENDING_BYTES) {
      return this.#fail(new Error('resource pending limit exceeded'));
    }
    admitted();
    return new Promise<void>((resolve, reject) => {
      const item = { envelope, bytes, resolve, reject };
      if (!this.#active) {
        this.#active = item;
        void this.#pump();
      } else {
        this.#pending.push(item);
        this.#pendingBytes += bytes;
      }
    });
  }

  #fail(error: Error): Promise<never> {
    this.close(error);
    this.failed(error);
    return Promise.reject(error);
  }

  close(error = new Error('resource output closed')): void {
    if (this.#closed) return;
    this.#closed = true;
    this.signal.removeEventListener('abort', this.#abort);
    this.response.removeListener('close', this.#abort);
    this.#releaseDrain?.();
    this.#active?.reject(error);
    for (const item of this.#pending.splice(0)) item.reject(error);
    this.#pendingBytes = 0;
    if (!this.response.destroyed && !this.response.writableEnded) this.response.end();
  }

  async #pump(): Promise<void> {
    try {
      while (this.#active && !this.#closed) {
        const item = this.#active;
        for (const frame of ('views' in item.envelope ? [{event:'resource-coverage' as const,data:item.envelope as unknown as Record<string,unknown>}] : resourceFrames(item.envelope))) {
          if (this.#closed) break;
          const writable = this.response.write(`event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`);
          if (!writable) await this.#drain();
        }
        if (this.#closed) break;
        item.resolve();
        this.#active = this.#pending.shift();
        if (this.#active) this.#pendingBytes -= this.#active.bytes;
      }
    } catch (error) {
      const failure = error instanceof Error ? error : new Error('resource output failed');
      this.close(failure);
      this.failed(failure);
    }
  }

  #drain(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    return new Promise(resolve => {
      const release = () => {
        this.response.removeListener('drain', release);
        this.#releaseDrain = undefined;
        resolve();
      };
      this.#releaseDrain = release;
      this.response.once('drain', release);
    });
  }
}

interface BoundProjection {
  readonly payload: unknown;
  readonly source: IdentityResourcePosition;
  readonly producerGeneration: string;
  readonly revision: number;
  readonly baselineId: string;
  readonly descriptor: ResourceDescriptor;
}
interface ResourceView {
  descriptor: ResourceDescriptor;
  epoch: number;
  baselineId: string;
  controller: AbortController;
  revision: number;
  sequence: number;
  dirty: boolean;
  running: boolean;
  failed: boolean;
  initial: Promise<BoundProjection>;
  resolveInitial: (value: BoundProjection) => void;
  rejectInitial: (error: Error) => void;
  payload?: unknown;
  covered?: IdentityResourcePosition;
  localRevision: number;
  qualifiedAt?: number;
}
interface ActivityRead {
  readonly source: IdentityResourcePosition;
  readonly controller: AbortController;
  readonly users: Set<symbol>;
  promise: Promise<unknown>;
  settled: boolean;
}
const sameSource = (a: IdentityResourcePosition, b: IdentityResourcePosition) =>
  a.producerGeneration === b.producerGeneration && a.position === b.position;
interface Connection {
  id: string;
  controller: AbortController;
  output: ResourceOutput;
  views: Map<string, ResourceView>;
  epochs: Map<string, number>;
  observer: ResourceObserverHandle;
  localRevision: number;
  projectionTail: Promise<void>;
  source?: IdentityResourcePosition;
  coverageQueued: boolean;
  coverageAt?: number;
  close: () => void;
}

export class ResourceBindingError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** Ephemeral single-service identity scope; connectionId is transport state,
 * never a credential. Browser authorization remains the deployment boundary. */
export class ResourceConnections {
  readonly #connections = new Map<string, Connection>();
  #activityRead?: ActivityRead;
  readonly producerGeneration = randomUUID();
  constructor(readonly deps: {
    client: OursClient;
    identity: string;
    identityCid: string;
    stateDir: string;
    project(descriptor: ResourceDescriptor, signal: AbortSignal, source?: IdentityResourcePosition): Promise<unknown>;
  }) {}

  /** Ordinary and bound demands share only pending work in this service scope.
   * Every new demand crosses the bound SDK API; source position is not a lease. */
  async activity(signal: AbortSignal, bound?: { connection: Connection; view: ResourceView; source?: IdentityResourcePosition },
    deadlineMs = ACTIVITY_DEADLINE_MS): Promise<unknown> {
    signal.throwIfAborted();
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new Error('activity metadata unavailable')), deadlineMs);
    try { return await this.#readActivity(AbortSignal.any([signal, deadline.signal]), bound); }
    finally { clearTimeout(timer); }
  }

  async #readActivity(signal: AbortSignal, bound?: { connection: Connection; view: ResourceView; source?: IdentityResourcePosition }): Promise<unknown> {
    signal.throwIfAborted();
    const source = await abortableProjection(this.deps.client.resourcePosition(this.deps.identity, { signal }), signal);
    signal.throwIfAborted();
    if (bound?.source && !sameSource(bound.source, source)) throw new Error('activity baseline changed');
    let read = this.#activityRead;
    if (read && (read.settled || read.controller.signal.aborted || !sameSource(read.source, source))) {
      // Already-admitted storage work still owns its slot until it drains.
      // A later genuine demand can start fresh; this request schedules no retry.
      throw new Error('activity prior source still draining');
    }
    if (!read) {
      read = { source, controller: new AbortController(), users: new Set(),
        promise: undefined!, settled: false };
      const owned = read;
      this.#activityRead = owned;
      owned.promise = Promise.resolve().then(() => {
        owned.controller.signal.throwIfAborted();
        return this.deps.project({ viewId: 'activity', resource: 'activity' }, owned.controller.signal, source);
      }).finally(() => {
        owned.settled = true;
        if (this.#activityRead === owned && !owned.users.size) this.#activityRead = undefined;
      });
      // Last-reader retirement does not make a late RPC rejection unobserved.
      void owned.promise.catch(() => {});
    }
    const owned = read, user = Symbol('activity reader');
    owned.users.add(user);
    try {
      const payload = await abortableProjection(owned.promise, signal);
      const after = await abortableProjection(this.deps.client.resourcePosition(this.deps.identity, { signal }), signal);
      signal.throwIfAborted();
      if (!sameSource(source, after)) throw new Error('activity source changed');
      if (bound) {
        if (!this.#current(bound.connection, bound.view)) throw new Error('activity owner retired');
      }
      return payload;
    } finally {
      owned.users.delete(user);
      if (!owned.users.size) {
        owned.controller.abort();
        if (owned.settled && this.#activityRead === owned) this.#activityRead = undefined;
      }
    }
  }

  open(response: ServerResponse): { connectionId: string; close(): void; closed: Promise<void> } {
    const id = randomUUID(), controller = new AbortController();
    let resolveClosed!: () => void;
    const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
    let connection: Connection | undefined;
    const close = () => {
      if (controller.signal.aborted) return;
      controller.abort();
      this.#connections.delete(id);
      if (connection) {
        for (const view of connection.views.values()) this.#retire(view);
        connection.views.clear();
        connection.output.close();
        void connection.observer.stop().catch(() => {});
      }
      response.removeListener('close', close);
      resolveClosed();
    };
    const output = new ResourceOutput(response, controller.signal, close);
    const observer = startResourceObserver(this.deps.client, this.deps.identity, {
      committed: frame => {
        if (!connection || controller.signal.aborted) return;
        connection.source = frame;
        for (const view of connection.views.values()) {
          if (!view.covered || frame.position > view.covered.position) this.#schedule(connection, view);
        }
        if (frame.kind === 'coverage') void this.#coverage(connection, frame).catch(close);
        else this.#queueCoverage(connection);
      },
      failed: error => {
        if (!connection || controller.signal.aborted) return;
        const reason = 'status' in error && (error.status === 401 || error.status === 403) ? 'auth_required'
          : 'status' in error && error.status === 404 ? 'unsupported' : 'upstream_unavailable';
        const writes = [...connection.views.values()].map(view => {
          view.failed = true;
          view.rejectInitial(error);
          view.controller.abort();
          return this.#emit(connection!, view, 'health', { healthy: false, reason });
        });
        if (!writes.length) {
          response.write(`event: resource-service-health\ndata: ${JSON.stringify({ protocolVersion: 1,
            connectionId: id, producerGeneration: this.producerGeneration, healthy: false, reason })}\n\n`);
          close();
        }
        else void Promise.allSettled(writes).then(close);
      },
    });
    connection = { id, controller, output, views: new Map(), epochs: new Map(), observer, localRevision: 0, projectionTail: Promise.resolve(), coverageQueued: false, close };
    this.#connections.set(id, connection);
    response.once('close', close);
    subscribeHumanProfile(this.deps.stateDir, this.deps.identityCid, () => {
      if (!connection || controller.signal.aborted) return;
      connection.localRevision++;
      for (const view of connection.views.values()) if (view.descriptor.resource === 'identity') this.#schedule(connection, view);
    }, controller.signal);
    response.write(`event: resource-connection\ndata: ${JSON.stringify({ protocolVersion: 1, connectionId: id,
      producerGeneration: this.producerGeneration, identityCid: this.deps.identityCid, baselineRequired: true, continuity: 'reset' })}\n\n`);
    return { connectionId: id, close, closed };
  }

  async register(connectionId: string, viewId: string, epoch: number, input: unknown, signal?: AbortSignal): Promise<{ subscriptionEpoch: number; baselineId: string }> {
    const connection = this.#get(connectionId);
    let descriptor: ResourceDescriptor;
    try { descriptor = canonicalResourceDescriptor(input); }
    catch { throw new ResourceBindingError(400, 'invalid resource descriptor'); }
    if (descriptor.viewId !== viewId || !Number.isSafeInteger(epoch) || epoch < 1) throw new ResourceBindingError(400, 'invalid subscription epoch');
    const priorEpoch = connection.epochs.get(viewId);
    if (priorEpoch !== undefined && epoch <= priorEpoch) throw new ResourceBindingError(409, 'obsolete subscription epoch');
    if (!connection.epochs.has(viewId) && connection.epochs.size >= 256) throw new ResourceBindingError(503, 'resource epoch capacity exceeded');
    // Source ready means observation is installed, not that any view is healthy.
    const lifetime = signal ? AbortSignal.any([signal, connection.controller.signal]) : connection.controller.signal;
    await abortableProjection(connection.observer.ready, lifetime);
    lifetime.throwIfAborted();
    if (connection.controller.signal.aborted || !connection.observer.healthy) throw new ResourceBindingError(503, 'resource source unavailable');
    // Another concurrent POST may have installed a newer epoch while awaiting ready.
    const current = connection.views.get(viewId);
    if ((connection.epochs.get(viewId) ?? 0) >= epoch) throw new ResourceBindingError(409, 'obsolete subscription epoch');
    if (!connection.epochs.has(viewId) && connection.epochs.size >= 256) throw new ResourceBindingError(503, 'resource epoch capacity exceeded');
    if (current) this.#retire(current);
    let resolveInitial!: ResourceView['resolveInitial'], rejectInitial!: ResourceView['rejectInitial'];
    const initial = new Promise<BoundProjection>((resolve, reject) => { resolveInitial = resolve; rejectInitial = reject; });
    void initial.catch(() => {});
    const view: ResourceView = { descriptor, epoch, baselineId: randomUUID(), controller: new AbortController(), revision: 0,
      sequence: 0, dirty: false, running: false, failed: false, initial, resolveInitial, rejectInitial, localRevision: -1 };
    connection.views.set(viewId, view);
    connection.epochs.set(viewId, epoch);
    this.#schedule(connection, view);
    return { subscriptionEpoch: epoch, baselineId: view.baselineId };
  }

  remove(connectionId: string, viewId: string, epoch: number): void {
    if (typeof viewId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(viewId) || !Number.isSafeInteger(epoch) || epoch < 1) throw new ResourceBindingError(400, 'invalid subscription epoch');
    const connection = this.#connections.get(connectionId);
    if (!connection) return;
    if (!connection.epochs.has(viewId) && connection.epochs.size >= 256) throw new ResourceBindingError(503, 'resource epoch capacity exceeded');
    // Independent DELETE can beat a registration still awaiting source ready.
    // Keep a bounded monotonic fence even before the first view is installed.
    connection.epochs.set(viewId, Math.max(connection.epochs.get(viewId) ?? 0, epoch));
    const view = connection.views.get(viewId);
    if (view && epoch >= view.epoch) {
      this.#retire(view);
      connection.views.delete(viewId);
    }
  }

  async bound(connectionId: string, viewId: string, epoch: number, baselineId: string): Promise<BoundProjection> {
    const connection = this.#get(connectionId), view = connection.views.get(viewId);
    if (!view || view.epoch !== epoch || view.baselineId !== baselineId) throw new ResourceBindingError(409, 'resource binding mismatch');
    const baseline = await view.initial;
    if (!this.#current(connection, view) || view.failed || !connection.observer.healthy) throw new ResourceBindingError(409, 'resource binding retired');
    if (view.descriptor.resource === 'activity') {
      // The identity observer cannot authorize a connector lease. Re-read via
      // the bound SDK API even at the same source; never serve an old capture.
      try {
        const payload = await this.activity(view.controller.signal, { connection, view, source: baseline.source });
        if (!this.#current(connection, view) || view.failed || !connection.observer.healthy
            || !view.covered || !sameSource(baseline.source, view.covered))
          throw new Error('activity baseline changed');
        return { ...baseline, payload };
      } catch {
        view.failed = true;
        this.#retire(view);
        throw new ResourceBindingError(409, 'resource activity binding retired');
      }
    }
    return baseline;
  }

  #get(id: string): Connection {
    const connection = this.#connections.get(id);
    if (!connection) throw new ResourceBindingError(409, 'unknown resource connection');
    return connection;
  }
  #current(connection: Connection, view: ResourceView): boolean {
    return !connection.controller.signal.aborted && !view.controller.signal.aborted
      && connection.views.get(view.descriptor.viewId) === view;
  }
  #retire(view: ResourceView): void {
    view.controller.abort();
    view.rejectInitial(new ResourceBindingError(409, 'resource binding retired'));
  }
  #emit(connection: Connection, view: ResourceView, kind: ResourceEnvelope['kind'], payload: unknown, source?: IdentityResourcePosition): Promise<void> {
    return connection.output.send({ protocolVersion: 1, producerGeneration: this.producerGeneration,
      viewId: view.descriptor.viewId, subscriptionEpoch: view.epoch, sequence: view.sequence+1,
      revision: view.revision, baselineId: view.baselineId, kind, payload, ...(source ? {source} : {}) } as ResourceEnvelope, () => {view.sequence++;if(source||kind==='ready')view.qualifiedAt=Date.now();});
  }
  #queueCoverage(connection: Connection): void {
    if (connection.coverageQueued) return;
    connection.coverageQueued = true;
    // A committed wake can suppress SDK heartbeats. Wait for its existing
    // projection queue to settle so unchanged siblings share one due envelope.
    // New source turns extend that same queue; no cached-health timer is added.
    void (async () => {
      try {
        let tail: Promise<void>;
        do {
          tail = connection.projectionTail;
          await tail;
        } while (tail !== connection.projectionTail && !connection.controller.signal.aborted);
        if (!connection.controller.signal.aborted && connection.source) {
          void this.#coverage(connection, connection.source).catch(connection.close);
        }
      } finally { connection.coverageQueued = false; }
    })().catch(connection.close);
  }
  #coverage(connection: Connection, source: IdentityResourcePosition): Promise<void> {
    const now = Date.now();
    if (now-(connection.coverageAt ?? -Infinity)<15_000 || !connection.observer.healthy) return Promise.resolve();
    const eligible = [...connection.views.values()].filter(view => this.#current(connection,view) && !view.failed
      && !view.running && !view.dirty && view.payload !== undefined && view.covered
      && view.covered.producerGeneration === source.producerGeneration && view.covered.position === source.position
      && (view.descriptor.resource !== 'identity' || view.localRevision === connection.localRevision)
      && now-(view.qualifiedAt ?? 0)>=15_000);
    if (!eligible.length) return Promise.resolve();
    const views = eligible.map(view => ({protocolVersion:1 as const,producerGeneration:this.producerGeneration,
      viewId:view.descriptor.viewId,subscriptionEpoch:view.epoch,baselineId:view.baselineId,
      sequence:view.sequence+1,revision:view.revision,source:view.covered!}));
    return connection.output.send({protocolVersion:1,producerGeneration:this.producerGeneration,views},()=>{
      connection.coverageAt=now;
      for (const view of eligible) {view.sequence++;view.qualifiedAt=now;}
    });
  }
  #schedule(connection: Connection, view: ResourceView): void {
    if (!this.#current(connection, view) || view.failed) return;
    view.dirty = true;
    if (view.running) return;
    view.running = true;
    const task = connection.projectionTail.then(() => this.#refresh(connection, view));
    connection.projectionTail = task.catch(() => {});
    void task.finally(() => {
      view.running = false;
      if (view.dirty) this.#schedule(connection, view);
    }).catch(connection.close);
  }
  async #refresh(connection: Connection, view: ResourceView): Promise<void> {
    try {
      // One atomic capture/send per queue turn. The scheduling finally hook
      // appends any newly dirty work behind other views already waiting.
      if (view.dirty && this.#current(connection, view)) {
        view.dirty = false;
        const captured = await captureResourceProjection(this.deps.client, this.deps.identity, async () => {
          const payload = view.descriptor.resource === 'activity'
            ? await this.activity(view.controller.signal, { connection, view })
            : await this.deps.project(view.descriptor, view.controller.signal);
          const delta = view.descriptor.resource === 'messages' && view.payload !== undefined
            ? await messageProjectionDelta(this.deps.client, view.payload as MessageResourceSnapshot,
              payload as MessageResourceSnapshot, view.controller.signal) : undefined;
          return { payload, delta };
        }, view.controller.signal, () => connection.localRevision);
        if (!this.#current(connection, view)) return;
        if (!connection.observer.healthy || captured.source.producerGeneration !== connection.observer.generation) {
          throw new Error('resource source continuity lost');
        }
        const first = view.payload === undefined;
        const changed = first || JSON.stringify(captured.payload.payload) !== JSON.stringify(view.payload);
        view.covered = captured.source;
        view.localRevision = connection.localRevision;
        if (changed) {
          view.revision++;
          if (first || view.descriptor.resource !== 'messages') {
            await this.#emit(connection, view, 'snapshot', captured.payload.payload, captured.source);
          } else {
            await this.#emit(connection, view, 'upsert', captured.payload.delta, captured.source);
          }
          if (!this.#current(connection, view)) return;
          view.payload = captured.payload.payload;
        }
        if (first) {
          await this.#emit(connection, view, 'ready', { baselineId: view.baselineId, source: captured.source });
          if (!this.#current(connection, view)) return;
          view.resolveInitial({ payload: view.payload, source: captured.source, producerGeneration: this.producerGeneration,
            revision: view.revision, baselineId: view.baselineId, descriptor: view.descriptor });
        }
      }
    } catch (error) {
      if (!this.#current(connection, view)) return;
      view.failed = true;
      const failure = error instanceof Error ? error : new Error('resource projection failed');
      view.rejectInitial(failure);
      await this.#emit(connection, view, 'resync', { reason: /limit/.test(failure.message) ? 'capacity' : 'projection_unavailable' }).catch(connection.close);
    }
  }
}
