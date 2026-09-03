import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { JsonValue } from '@ours.network/sdk';

export type InvocationStatus = 'indeterminate' | 'accepted' | 'failed';
export interface InvocationRecord {
  readonly invocation_id: string;
  readonly recipient_cid: string;
  readonly payload_fingerprint: string;
  readonly command: string;
  readonly catalog_fingerprint: string;
  readonly created_at: string;
  readonly status: InvocationStatus;
  readonly wire_id: string | null;
  readonly delivery: string;
}

interface State { version: 1; records: Record<string, InvocationRecord> }
const MAX_RECORDS = 4_096;

function canonical(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

export function invocationFingerprint(input: {
  recipient_cid: string; command: string; arguments: JsonValue; catalog_fingerprint: string;
}): string {
  return createHash('sha256').update(canonical(input as unknown as JsonValue)).digest('base64url');
}

function validRecord(value: unknown): value is InvocationRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Partial<InvocationRecord>;
  return typeof row.invocation_id === 'string' && typeof row.recipient_cid === 'string'
    && typeof row.payload_fingerprint === 'string' && typeof row.command === 'string'
    && typeof row.catalog_fingerprint === 'string' && typeof row.created_at === 'string'
    && (row.status === 'indeterminate' || row.status === 'accepted' || row.status === 'failed')
    && (row.wire_id === null || typeof row.wire_id === 'string') && typeof row.delivery === 'string';
}

export class CommandInvocationStore {
  private constructor(private readonly file: string, private state: State) {}

  static open(stateDir: string, identityCid: string): CommandInvocationStore {
    const file = join(stateDir, `typed-commands-${createHash('sha256').update(identityCid).digest('hex').slice(0, 24)}.json`);
    let state: State = { version: 1, records: {} };
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || (parsed as State).version !== 1
        || !(parsed as State).records || typeof (parsed as State).records !== 'object'
        || !Object.values((parsed as State).records).every(validRecord)) {
        throw new Error('invalid typed command invocation state');
      }
      state = parsed as State;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return new CommandInvocationStore(file, state);
  }

  begin(input: Omit<InvocationRecord, 'created_at' | 'status' | 'wire_id' | 'delivery'>):
    { fresh: boolean; record: InvocationRecord } {
    const existing = this.state.records[input.invocation_id];
    if (existing) {
      if (existing.recipient_cid !== input.recipient_cid || existing.payload_fingerprint !== input.payload_fingerprint) {
        throw new Error('invocation_id is already bound to a different recipient or payload');
      }
      return { fresh: false, record: existing };
    }
    const record: InvocationRecord = {
      ...input, created_at: new Date().toISOString(), status: 'indeterminate', wire_id: null, delivery: 'indeterminate',
    };
    this.state.records[input.invocation_id] = record;
    this.trim();
    this.save();
    return { fresh: true, record };
  }

  complete(invocationId: string, update: Pick<InvocationRecord, 'wire_id' | 'delivery'>): InvocationRecord {
    const current = this.state.records[invocationId];
    if (!current) throw new Error('invocation reservation is missing');
    const record: InvocationRecord = {
      ...current, ...update, status: update.wire_id ? 'accepted' : update.delivery === 'refused' ? 'failed' : 'indeterminate',
    };
    this.state.records[invocationId] = record;
    this.save();
    return record;
  }

  private trim(): void {
    const rows = Object.values(this.state.records).sort((a, b) => a.created_at.localeCompare(b.created_at));
    for (const row of rows.slice(0, Math.max(0, rows.length - MAX_RECORDS))) delete this.state.records[row.invocation_id];
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(this.state), { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, this.file);
  }
}
