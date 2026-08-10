// WEBPUSH, SERVER-SIDE, WITH NO MUFL IN IT.
//
// This is the plain WebPush application-server role and nothing more. The browser
// subscribes, POSTs its `{endpoint, keys:{p256dh, auth}}` here, and when a message
// lands in the packet ON THIS SERVER, THIS SERVER signs with VAPID and POSTs to
// that endpoint. There is no notification service in the path: the user self-hosts
// this, so the thing that learns about the message is the thing that sends the push.
//
// The old `a2a_notifications` surface — handout ledger, token issue/rotate/revoke,
// five hooks — is deliberately absent. It existed because a browser node had to
// hand tokens to a third party. A server does not.
//
// WHAT GOES IN A PUSH PAYLOAD: the sender and a count, never message text. The
// payload is encrypted to the subscription, but it still passes through a push
// service we do not run, and it is written to a device's notification store. The
// daemon's own notification stream is content-free for the same reason, and there
// is no reason for us to be less careful than the thing we are relaying.

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import webpush from 'web-push';

export interface PushSubscriptionRecord {
  readonly endpoint: string;
  readonly keys: { readonly p256dh: string; readonly auth: string };
  readonly createdAt: string;
  /** Free-form label from the client, e.g. a device name. Never used for routing. */
  readonly label?: string;
}

interface VapidKeys {
  readonly publicKey: string;
  readonly privateKey: string;
  readonly subject: string;
}

interface PushState {
  vapid: VapidKeys;
  subscriptions: PushSubscriptionRecord[];
}

/** What a push carries. Sender and counts only — see the header. */
export interface PushEvent {
  readonly kind: 'message' | 'file';
  readonly from?: string;
  readonly count: number;
}

export class PushStore {
  private readonly file: string;
  private state: PushState;

  private constructor(file: string, state: PushState) {
    this.file = file;
    this.state = state;
  }

  /**
   * Load, or create on first run.
   *
   * THE VAPID PRIVATE KEY IS A CREDENTIAL and this file is written 0600. A
   * self-hosted operator gets working push without generating anything by hand;
   * one who wants to pin a key pair (so a reinstall does not invalidate every
   * existing browser subscription) supplies it through the environment instead.
   */
  static open(stateDir: string, env: NodeJS.ProcessEnv = process.env): PushStore {
    const file = join(stateDir, 'push.json');
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });

    let state: PushState | undefined;
    try {
      state = JSON.parse(readFileSync(file, 'utf8')) as PushState;
    } catch {
      state = undefined;
    }

    const subject = env.OURS_MESSENGER_VAPID_SUBJECT ?? 'mailto:admin@localhost';
    const envPublic = env.OURS_MESSENGER_VAPID_PUBLIC_KEY;
    const envPrivate = env.OURS_MESSENGER_VAPID_PRIVATE_KEY;

    // A HALF-SUPPLIED PAIR IS AN ERROR, NOT A FALLBACK. Silently generating a
    // fresh key because only one half was set would invalidate every subscription
    // an operator was trying to preserve, and the symptom — pushes that vanish
    // after a restart — names neither the cause nor this file.
    if ((envPublic === undefined) !== (envPrivate === undefined)) {
      throw new Error(
        'OURS_MESSENGER_VAPID_PUBLIC_KEY and OURS_MESSENGER_VAPID_PRIVATE_KEY must be set together or not at all.',
      );
    }

    if (envPublic && envPrivate) {
      state = { vapid: { publicKey: envPublic, privateKey: envPrivate, subject }, subscriptions: state?.subscriptions ?? [] };
    } else if (!state?.vapid?.publicKey || !state?.vapid?.privateKey) {
      const generated = webpush.generateVAPIDKeys();
      state = { vapid: { ...generated, subject }, subscriptions: state?.subscriptions ?? [] };
    } else {
      state = { vapid: { ...state.vapid, subject }, subscriptions: state.subscriptions ?? [] };
    }

    const store = new PushStore(file, state);
    store.persist();
    return store;
  }

  private persist(): void {
    // Write-then-rename: a crash mid-write must not leave a truncated key pair
    // behind, because the recovery from that is "every device re-subscribes".
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
  }

  /** The only half of the pair a browser is allowed to see. */
  get publicKey(): string {
    return this.state.vapid.publicKey;
  }

  list(): readonly PushSubscriptionRecord[] {
    return this.state.subscriptions;
  }

  /** Idempotent on `endpoint`: re-subscribing a device replaces it, never duplicates it. */
  subscribe(rec: Omit<PushSubscriptionRecord, 'createdAt'>): PushSubscriptionRecord {
    const full: PushSubscriptionRecord = { ...rec, createdAt: new Date().toISOString() };
    this.state.subscriptions = [...this.state.subscriptions.filter((s) => s.endpoint !== rec.endpoint), full];
    this.persist();
    return full;
  }

  /** Returns whether anything was actually removed, so the route can answer honestly. */
  unsubscribe(endpoint: string): boolean {
    const before = this.state.subscriptions.length;
    this.state.subscriptions = this.state.subscriptions.filter((s) => s.endpoint !== endpoint);
    const removed = this.state.subscriptions.length !== before;
    if (removed) this.persist();
    return removed;
  }

  /**
   * Send one event to every subscription.
   *
   * 404 AND 410 PRUNE THE SUBSCRIPTION. That is the push service telling us the
   * endpoint is permanently gone — the user cleared site data, or the browser
   * rotated it. Retrying those forever is how a self-hosted server ends up
   * spending every wake-up POSTing to dead endpoints, and it is the one failure
   * mode of this role that gets worse rather than louder over time.
   *
   * Every other failure is left in place and reported: a 500 from a push service,
   * or a network blip, must not cost a real device its subscription.
   */
  async send(event: PushEvent): Promise<{ sent: number; pruned: number; failed: number; errors: string[] }> {
    const payload = JSON.stringify(event);
    const vapidDetails = {
      subject: this.state.vapid.subject,
      publicKey: this.state.vapid.publicKey,
      privateKey: this.state.vapid.privateKey,
    };

    let sent = 0;
    let failed = 0;
    const dead: string[] = [];
    // THE REASON, NOT JUST THE COUNT. An earlier version returned `failed: 1` and
    // nothing else; the first time a push failed in a test the only evidence was
    // "1 subscription(s) failed (kept for retry)", which names neither the status
    // nor the endpoint nor the library's message. A counter without a cause turns
    // a five-second diagnosis into a bisect.
    const errors: string[] = [];

    await Promise.all(
      this.list().map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } },
            payload,
            { vapidDetails },
          );
          sent++;
        } catch (e) {
          const status = (e as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            dead.push(sub.endpoint);
          } else {
            failed++;
            // The endpoint's ORIGIN only. A full push endpoint is a capability —
            // anyone holding it can send that device notifications — and this
            // string goes to a log file.
            let origin = 'unparseable-endpoint';
            try {
              origin = new URL(sub.endpoint).origin;
            } catch {
              /* keep the placeholder */
            }
            errors.push(`${origin}: ${status ?? 'no status'}: ${(e as Error).message}`);
          }
        }
      }),
    );

    for (const endpoint of dead) this.unsubscribe(endpoint);
    return { sent, pruned: dead.length, failed, errors };
  }
}
