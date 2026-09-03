import { useMemo, useState } from 'react';
import { ApiError } from '../api.js';
import type { CommandCatalog, CommandDefinition, JsonValue, SendCommandResult } from '../types.js';

const SUPPORTED = new Set([
  'type', 'title', 'description', 'default', 'enum', 'minimum', 'maximum',
  'minLength', 'maxLength', 'properties', 'required', 'items', 'minItems', 'maxItems',
]);
const MAX_DEPTH = 6;
const MAX_CONTROLS = 64;

type Schema = { [key: string]: JsonValue };

function schemaError(schema: Schema, depth = 0, count = { value: 0 }): string | null {
  if (depth > MAX_DEPTH) return `Schema depth exceeds ${MAX_DEPTH}`;
  count.value++;
  if (count.value > MAX_CONTROLS) return `Schema exceeds ${MAX_CONTROLS} controls`;
  const unsupported = Object.keys(schema).find((key) => !SUPPORTED.has(key));
  if (unsupported) return `Unsupported JSON Schema keyword: ${unsupported}`;
  if (schema.title !== undefined && typeof schema.title !== 'string') return 'title must be a string';
  if (schema.description !== undefined && typeof schema.description !== 'string') return 'description must be a string';
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) return 'enum must be a non-empty array';
  const type = schema.type;
  if (type === undefined && schema.enum === undefined) return 'An explicit type or enum is required';
  if (type !== undefined && !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(String(type))) {
    return `Unsupported JSON Schema type: ${String(type)}`;
  }
  for (const keyword of ['minimum', 'maximum'] as const) {
    if (schema[keyword] !== undefined && (typeof schema[keyword] !== 'number' || !Number.isFinite(schema[keyword]))) {
      return `${keyword} must be a finite number`;
    }
  }
  for (const keyword of ['minLength', 'maxLength', 'minItems', 'maxItems'] as const) {
    if (schema[keyword] !== undefined && (typeof schema[keyword] !== 'number'
      || !Number.isInteger(schema[keyword]) || schema[keyword] < 0)) return `${keyword} must be a non-negative integer`;
  }
  if ((schema.minimum !== undefined || schema.maximum !== undefined) && type !== 'number' && type !== 'integer') {
    return 'minimum/maximum require a numeric type';
  }
  if ((schema.minLength !== undefined || schema.maxLength !== undefined) && type !== 'string') {
    return 'minLength/maxLength require string type';
  }
  if ((schema.minItems !== undefined || schema.maxItems !== undefined) && type !== 'array') {
    return 'minItems/maxItems require array type';
  }
  if (type === 'object') {
    const properties = schema.properties;
    if (properties !== undefined && (!properties || typeof properties !== 'object' || Array.isArray(properties))) {
      return 'properties must be an object';
    }
    if (schema.required !== undefined && (!Array.isArray(schema.required)
      || schema.required.some((key) => typeof key !== 'string'))) return 'required must be an array of property names';
    for (const child of Object.values((properties ?? {}) as Record<string, JsonValue>)) {
      if (!child || typeof child !== 'object' || Array.isArray(child)) return 'property schema must be an object';
      const error = schemaError(child as Schema, depth + 1, count);
      if (error) return error;
    }
  }
  if (type === 'array' && schema.items !== undefined) {
    if (!schema.items || typeof schema.items !== 'object' || Array.isArray(schema.items)) return 'items must be one schema object';
    return schemaError(schema.items as Schema, depth + 1, count);
  }
  return null;
}

function sameJson(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => sameJson(value, right[index]));
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) =>
    key === rightKeys[index] && sameJson(left[key], right[key]));
}

export function validateCommandValue(schema: Schema, value: JsonValue, path = 'Arguments'): string | null {
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => sameJson(option, value))) return `${path} is not an allowed value`;
  if (schema.type === 'null') return value === null ? null : `${path} must be null`;
  if (schema.type === 'boolean') return typeof value === 'boolean' ? null : `${path} must be boolean`;
  if (schema.type === 'string') {
    if (typeof value !== 'string') return `${path} must be text`;
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) return `${path} is too short`;
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) return `${path} is too long`;
    return null;
  }
  if (schema.type === 'number' || schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return `${path} must be a finite number`;
    if (schema.type === 'integer' && !Number.isInteger(value)) return `${path} must be an integer`;
    if (typeof schema.minimum === 'number' && value < schema.minimum) return `${path} is below the minimum`;
    if (typeof schema.maximum === 'number' && value > schema.maximum) return `${path} is above the maximum`;
    return null;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return `${path} must be an array`;
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) return `${path} has too few items`;
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) return `${path} has too many items`;
    if (schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)) {
      for (let index = 0; index < value.length; index++) {
        const error = validateCommandValue(schema.items as Schema, value[index], `${path}[${index}]`);
        if (error) return error;
      }
    }
    return null;
  }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return `${path} must be an object`;
    const required = Array.isArray(schema.required) ? schema.required as string[] : [];
    for (const key of required) if (!Object.hasOwn(value, key)) return `${path}.${key || '(empty key)'} is required`;
    for (const [key, child] of Object.entries((schema.properties ?? {}) as Record<string, JsonValue>)) {
      if (!Object.hasOwn(value, key)) continue;
      const error = validateCommandValue(child as Schema, value[key], `${path}.${key || '(empty key)'}`);
      if (error) return error;
    }
  }
  return null;
}

function initialValue(schema: Schema): JsonValue {
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if (schema.type === 'object') {
    const result: Record<string, JsonValue> = Object.create(null);
    for (const [key, child] of Object.entries((schema.properties ?? {}) as Record<string, JsonValue>)) {
      result[key] = initialValue(child as Schema);
    }
    return result;
  }
  if (schema.type === 'array') return [];
  if (schema.type === 'boolean') return false;
  if (schema.type === 'number' || schema.type === 'integer') return 0;
  if (schema.type === 'null') return null;
  return '';
}

function labelFor(schema: Schema, fallback: string): string {
  return typeof schema.title === 'string' && schema.title ? schema.title : fallback || '(empty key)';
}

function Field(props: {
  schema: Schema; name: string; value: JsonValue; required?: boolean; onChange(value: JsonValue): void;
}) {
  const { schema, name, value, required, onChange } = props;
  const label = labelFor(schema, name);
  const description = typeof schema.description === 'string' ? schema.description : undefined;
  if (Array.isArray(schema.enum)) {
    return <label className="command-field"><span>{label}{required ? ' *' : ''}</span>
      <select value={JSON.stringify(value)} onChange={(event) => onChange(JSON.parse(event.target.value))}>
        {schema.enum.map((option, index) => <option key={index} value={JSON.stringify(option)}>{String(option)}</option>)}
      </select>{description && <small>{description}</small>}</label>;
  }
  if (schema.type === 'object') {
    const record = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const requiredKeys = new Set(Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === 'string') : []);
    return <fieldset className="command-object"><legend>{label}</legend>{description && <p>{description}</p>}
      {Object.entries((schema.properties ?? {}) as Record<string, JsonValue>).map(([key, child]) =>
        <Field key={key} schema={child as Schema} name={key} value={record[key] ?? initialValue(child as Schema)}
          required={requiredKeys.has(key)} onChange={(next) => onChange({ ...record, [key]: next })} />)}
    </fieldset>;
  }
  if (schema.type === 'array') {
    return <label className="command-field"><span>{label}{required ? ' *' : ''}</span>
      <textarea value={JSON.stringify(value, null, 2)} rows={3} aria-describedby={`${name}-array-help`}
        onChange={(event) => { try { const next = JSON.parse(event.target.value); if (Array.isArray(next)) onChange(next); } catch { /* visible native text remains until corrected */ } }} />
      <small id={`${name}-array-help`}>{description ?? 'JSON array'}</small></label>;
  }
  if (schema.type === 'boolean') {
    return <label className="command-check"><input type="checkbox" checked={value === true} onChange={(event) => onChange(event.target.checked)} /> {label}</label>;
  }
  if (schema.type === 'null') return <div className="command-field"><span>{label}</span><small>Null value</small></div>;
  const numeric = schema.type === 'number' || schema.type === 'integer';
  return <label className="command-field"><span>{label}{required ? ' *' : ''}</span>
    <input type={numeric ? 'number' : 'text'} value={String(value ?? '')}
      min={typeof schema.minimum === 'number' ? schema.minimum : undefined}
      max={typeof schema.maximum === 'number' ? schema.maximum : undefined}
      minLength={typeof schema.minLength === 'number' ? schema.minLength : undefined}
      maxLength={typeof schema.maxLength === 'number' ? schema.maxLength : undefined}
      step={schema.type === 'integer' ? 1 : numeric ? 'any' : undefined}
      required={required}
      onChange={(event) => onChange(numeric ? Number(event.target.value) : event.target.value)} />
    {description && <small>{description}</small>}</label>;
}

export function CommandPanel(props: {
  catalog: CommandCatalog;
  busy: boolean;
  onRefresh(): void;
  onClose(): void;
  onSend(command: CommandDefinition, args: JsonValue, invocationId: string): Promise<SendCommandResult>;
}) {
  const [selectedName, setSelectedName] = useState(props.catalog.commands[0]?.name ?? '');
  const command = props.catalog.commands.find((entry) => entry.name === selectedName) ?? props.catalog.commands[0];
  const unsupported = useMemo(() => command ? schemaError(command.input_schema) : null, [command]);
  const [value, setValue] = useState<JsonValue>(() => command ? initialValue(command.input_schema) : null);
  const [confirmed, setConfirmed] = useState(false);
  const [status, setStatus] = useState('');

  const choose = (name: string) => {
    const next = props.catalog.commands.find((entry) => entry.name === name);
    setSelectedName(name); setValue(next ? initialValue(next.input_schema) : null); setConfirmed(false); setStatus('');
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!command || unsupported || !confirmed || props.busy) return;
    const validationError = validateCommandValue(command.input_schema, value);
    if (validationError) { setStatus(`Validation denied: ${validationError}`); return; }
    const invocation = crypto.randomUUID();
    setStatus('Sending encrypted command…');
    try {
      const sent = await props.onSend(command, value, invocation);
      if (sent.status === 'failed') setStatus('Command was refused before delivery.');
      else if (sent.status === 'pending') setStatus('Command delivery is pending; do not submit it again.');
      else if (sent.status === 'indeterminate' || !sent.wire_id) setStatus('Command state is indeterminate; do not retry blindly.');
      else setStatus(sent.deduplicated ? 'Command was already accepted; pending result.' : 'Command accepted and pending result.');
    } catch (error) {
      setStatus(error instanceof ApiError
        ? `Command was not sent: ${error.message}`
        : 'Command connection was interrupted; its state may be indeterminate. Check the conversation before retrying.');
    }
  };
  return <form className="command-panel" aria-label="Send a typed command" onSubmit={submit}
    onKeyDown={(event) => { if (event.key === 'Escape') props.onClose(); }}>
    <div className="command-panel-head"><strong>Commands</strong><span className="mono">{props.catalog.recipient_cid.slice(0, 12)}…</span>
      <button type="button" className="linkbtn" onClick={props.onRefresh}>Refresh</button>
      <button type="button" className="icon-btn" aria-label="Close commands" onClick={props.onClose}>×</button></div>
    {props.catalog.commands.length === 0 ? <p role="status">This recipient does not advertise commands.</p> : <>
      <label className="command-field"><span>Command</span><select autoFocus value={command?.name} onChange={(event) => choose(event.target.value)}>
        {props.catalog.commands.map((entry) => <option key={entry.name} value={entry.name}>{entry.name}</option>)}
      </select></label>
      {command?.description && <p>{command.description}</p>}
      {unsupported ? <div className="banner error" role="alert">Cannot render this command safely: {unsupported}</div>
        : command && <Field schema={command.input_schema} name="Arguments" value={value} onChange={setValue} />}
      <label className="command-check"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
        Confirm sending this command. It may change data on the recipient.</label>
      <button className="btn primary" disabled={!!unsupported || !confirmed || props.busy}>Send command</button>
      <div className="command-status" role="status" aria-live="polite">{status}</div>
    </>}
  </form>;
}
