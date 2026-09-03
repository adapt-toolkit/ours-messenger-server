import { createHash } from 'node:crypto';
import type { CommandDefinition, JsonValue } from '@ours.network/sdk';

export const MAX_COMMANDS = 64;
export const MAX_COMMAND_NAME_LENGTH = 128;
export const MAX_COMMAND_DESCRIPTION_LENGTH = 2_048;
export const MAX_SCHEMA_BYTES = 64 * 1024;
export const MAX_JSON_DEPTH = 12;
export const MAX_JSON_NODES = 2_048;

export interface CommandCatalogView {
  readonly recipient_cid: string;
  readonly fingerprint: string;
  readonly commands: readonly CommandDefinition[];
}

export type TypedEnvelope =
  | { readonly kind: 'command'; readonly command: string; readonly arguments: JsonValue }
  | { readonly kind: 'command_result'; readonly outcome:
      | { readonly ok: true; readonly result: JsonValue }
      | { readonly ok: false; readonly error: string } }
  | { readonly kind: 'unknown'; readonly wire_kind: string; readonly malformed: boolean };

function jsonMetrics(value: JsonValue, depth = 0): { nodes: number; depth: number } {
  if (depth > MAX_JSON_DEPTH) throw new Error(`JSON value exceeds depth ${MAX_JSON_DEPTH}`);
  if (value === null || typeof value !== 'object') return { nodes: 1, depth };
  let nodes = 1;
  let deepest = depth;
  const values = Array.isArray(value) ? value : Object.values(value);
  for (const child of values) {
    const measured = jsonMetrics(child, depth + 1);
    nodes += measured.nodes;
    deepest = Math.max(deepest, measured.depth);
    if (nodes > MAX_JSON_NODES) throw new Error(`JSON value exceeds ${MAX_JSON_NODES} nodes`);
  }
  return { nodes, depth: deepest };
}

export function requireBoundedJson(value: unknown, label = 'arguments'): asserts value is JsonValue {
  const seen = new Set<object>();
  const visit = (item: unknown, depth: number): void => {
    if (depth > MAX_JSON_DEPTH) throw new Error(`${label} exceeds depth ${MAX_JSON_DEPTH}`);
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || seen.has(item)) throw new Error(`${label} must be valid JSON`);
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype) {
      throw new Error(`${label} must be valid JSON`);
    }
    seen.add(item);
    for (const child of Array.isArray(item) ? item : Object.values(item)) visit(child, depth + 1);
    seen.delete(item);
  };
  visit(value, 0);
  jsonMetrics(value as JsonValue);
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_SCHEMA_BYTES) {
    throw new Error(`${label} exceeds ${MAX_SCHEMA_BYTES} bytes`);
  }
}

function canonical(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

export function projectCatalog(recipientCid: string, commands: readonly CommandDefinition[]): CommandCatalogView {
  if (commands.length > MAX_COMMANDS) throw new Error(`command catalog exceeds ${MAX_COMMANDS} entries`);
  const projected = commands.map((command) => {
    if (!command.name || command.name.length > MAX_COMMAND_NAME_LENGTH) throw new Error('command name is invalid or too long');
    if (command.description !== undefined && command.description.length > MAX_COMMAND_DESCRIPTION_LENGTH) {
      throw new Error('command description is too long');
    }
    requireBoundedJson(command.input_schema, `schema for ${command.name}`);
    return {
      name: command.name,
      ...(command.description === undefined ? {} : { description: command.description }),
      input_schema: command.input_schema,
    };
  });
  const fingerprint = createHash('sha256').update(canonical({
    recipient_cid: recipientCid,
    commands: projected,
  } as unknown as JsonValue)).digest('base64url');
  return { recipient_cid: recipientCid, fingerprint, commands: projected };
}

export function parseTypedEnvelope(wireKind: string, body: string): TypedEnvelope | null {
  if (wireKind === 'text') return null;
  if (wireKind !== 'command' && wireKind !== 'command_result') {
    return { kind: 'unknown', wire_kind: wireKind, malformed: false };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(body); }
  catch { return { kind: 'unknown', wire_kind: wireKind, malformed: true }; }
  try { requireBoundedJson(parsed, wireKind); }
  catch { return { kind: 'unknown', wire_kind: wireKind, malformed: true }; }
  if (wireKind === 'command') {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { kind: 'unknown', wire_kind: wireKind, malformed: true };
    }
    const record = parsed as Record<string, unknown>;
    if (typeof record.command !== 'string' || record.command.length === 0 || record.command.length > MAX_COMMAND_NAME_LENGTH
      || !Object.hasOwn(record, 'arguments')) {
      return { kind: 'unknown', wire_kind: wireKind, malformed: true };
    }
    return { kind: 'command', command: record.command, arguments: record.arguments as JsonValue };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'unknown', wire_kind: wireKind, malformed: true };
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (record.ok === true && keys.length === 2 && keys[0] === 'ok' && keys[1] === 'result'
    && Object.hasOwn(record, 'result')) {
    return { kind: 'command_result', outcome: { ok: true, result: record.result as JsonValue } };
  }
  if (record.ok === false && keys.length === 2 && keys[0] === 'error' && keys[1] === 'ok'
    && typeof record.error === 'string' && record.error.length > 0 && record.error.length <= MAX_COMMAND_DESCRIPTION_LENGTH) {
    return { kind: 'command_result', outcome: { ok: false, error: record.error } };
  }
  return { kind: 'unknown', wire_kind: wireKind, malformed: true };
}
