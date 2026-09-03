import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
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
    const required = new Set(Array.isArray(schema.required)
      ? schema.required.filter((key): key is string => typeof key === 'string')
      : []);
    for (const [key, child] of Object.entries((schema.properties ?? {}) as Record<string, JsonValue>)) {
      const childSchema = child as Schema;
      if (required.has(key) || childSchema.default !== undefined) result[key] = initialValue(childSchema);
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

function withProperty(record: Record<string, JsonValue>, key: string, value: JsonValue): Record<string, JsonValue> {
  const next: Record<string, JsonValue> = Object.create(null);
  for (const [existingKey, existingValue] of Object.entries(record)) next[existingKey] = existingValue;
  next[key] = value;
  return next;
}

function withoutProperty(record: Record<string, JsonValue>, key: string): Record<string, JsonValue> {
  const next: Record<string, JsonValue> = Object.create(null);
  for (const [existingKey, existingValue] of Object.entries(record)) {
    if (existingKey !== key) next[existingKey] = existingValue;
  }
  return next;
}

function ArrayField(props: {
  schema: Schema; label: string; path: string; value: JsonValue; required?: boolean;
  description?: string; onChange(value: JsonValue): void; onValidityChange(path: string, error: string | null): void;
}) {
  const { schema, label, path, value, required, description, onChange, onValidityChange } = props;
  const generatedId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const pathId = path.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-|-$/g, '') || 'root';
  const helpId = `command-array-${pathId}-${generatedId}-help`;
  const [raw, setRaw] = useState(() => JSON.stringify(value, null, 2));
  const [error, setError] = useState<string | null>(null);
  const lastEmitted = useRef(JSON.stringify(value));

  useEffect(() => {
    const external = JSON.stringify(value);
    if (external !== lastEmitted.current) {
      lastEmitted.current = external;
      setRaw(JSON.stringify(value, null, 2));
      setError(null);
      onValidityChange(path, null);
    }
  }, [onValidityChange, path, value]);
  useEffect(() => () => onValidityChange(path, null), [onValidityChange, path]);

  const update = (nextRaw: string) => {
    setRaw(nextRaw);
    let parsed: unknown;
    try { parsed = JSON.parse(nextRaw); }
    catch { const nextError = `${label} must contain valid JSON`; setError(nextError); onValidityChange(path, nextError); return; }
    if (!Array.isArray(parsed)) {
      const nextError = `${label} must be a JSON array`;
      setError(nextError); onValidityChange(path, nextError); return;
    }
    const nextError = validateCommandValue(schema, parsed, label);
    setError(nextError); onValidityChange(path, nextError);
    lastEmitted.current = JSON.stringify(parsed);
    onChange(parsed);
  };

  return <label className="command-field"><span>{label}{required ? ' *' : ''}</span>
    <textarea value={raw} rows={3} aria-describedby={helpId} aria-invalid={error ? 'true' : undefined}
      onChange={(event) => update(event.target.value)} />
    <small id={helpId}>{description ?? 'JSON array'}</small>
    {error && <span className="command-field-error" role="alert">{error}</span>}
  </label>;
}

function Field(props: {
  schema: Schema; name: string; path: string; value: JsonValue; required?: boolean;
  onChange(value: JsonValue): void; onValidityChange(path: string, error: string | null): void;
}) {
  const { schema, name, path, value, required, onChange, onValidityChange } = props;
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
      {Object.entries((schema.properties ?? {}) as Record<string, JsonValue>).map(([key, child]) => {
        const childSchema = child as Schema;
        const present = Object.hasOwn(record, key);
        const childLabel = labelFor(childSchema, key);
        const childPath = `${path}.${key || '(empty key)'}`;
        if (!present && !requiredKeys.has(key)) {
          return <button key={key} type="button" className="linkbtn command-property-add"
            onClick={() => onChange(withProperty(record, key, initialValue(childSchema)))}>Add {childLabel}</button>;
        }
        return <div className="command-property" key={key}>
          <Field schema={childSchema} name={key} path={childPath}
            value={present ? record[key] : initialValue(childSchema)} required={requiredKeys.has(key)}
            onValidityChange={onValidityChange}
            onChange={(next) => onChange(withProperty(record, key, next))} />
          {!requiredKeys.has(key) && <button type="button" className="linkbtn command-property-remove"
            aria-label={`Remove ${childLabel}`} onClick={() => onChange(withoutProperty(record, key))}>Remove</button>}
        </div>;
      })}
    </fieldset>;
  }
  if (schema.type === 'array') {
    return <ArrayField schema={schema} label={label} path={path} value={value} required={required}
      description={description} onChange={onChange} onValidityChange={onValidityChange} />;
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
  storageScope: string;
  busy: boolean;
  onRefresh(): void;
  onClose(): void;
  onSend(command: CommandDefinition, args: JsonValue, invocationId: string, catalogFingerprint: string): Promise<SendCommandResult>;
}) {
  type Attempt = {
    version: 1; recipientCid: string; catalogFingerprint: string; command: string; arguments: JsonValue;
    invocationId: string; state: 'reserved' | SendCommandResult['status'];
  };
  const storageKey = `ours-command-attempt:${props.storageScope}:${props.catalog.recipient_cid}`;
  const readAttempt = (): Attempt | null => {
    if (typeof localStorage === 'undefined') return null;
    try {
      const parsed = JSON.parse(localStorage.getItem(storageKey) ?? 'null') as Partial<Attempt> | null;
      return parsed?.version === 1 && parsed.recipientCid === props.catalog.recipient_cid
        && typeof parsed.command === 'string' && typeof parsed.invocationId === 'string'
        && typeof parsed.catalogFingerprint === 'string' && Object.hasOwn(parsed, 'arguments')
        && (parsed.state === 'reserved' || parsed.state === 'accepted' || parsed.state === 'pending'
          || parsed.state === 'failed' || parsed.state === 'indeterminate')
        ? parsed as Attempt : null;
    } catch { return null; }
  };
  const initialAttempt = useMemo(readAttempt, [storageKey]);
  const [attempt, setAttempt] = useState<Attempt | null>(initialAttempt);
  const [selectedName, setSelectedName] = useState(initialAttempt?.command ?? props.catalog.commands[0]?.name ?? '');
  const command = props.catalog.commands.find((entry) => entry.name === selectedName) ?? props.catalog.commands[0];
  const unsupported = useMemo(() => command ? schemaError(command.input_schema) : null, [command]);
  const [value, setValue] = useState<JsonValue>(() => initialAttempt?.arguments ?? (command ? initialValue(command.input_schema) : null));
  const [confirmed, setConfirmed] = useState(false);
  const [status, setStatus] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const inFlightRef = useRef(false);
  const noteFieldError = useCallback((path: string, error: string | null) => {
    setFieldErrors((current) => {
      if (error === null) {
        if (!Object.hasOwn(current, path)) return current;
        const next = { ...current }; delete next[path]; return next;
      }
      return current[path] === error ? current : { ...current, [path]: error };
    });
  }, []);
  const persistAttempt = (next: Attempt | null) => {
    setAttempt(next);
    if (typeof localStorage === 'undefined') return;
    if (next) localStorage.setItem(storageKey, JSON.stringify(next)); else localStorage.removeItem(storageKey);
  };

  const choose = (name: string) => {
    const next = props.catalog.commands.find((entry) => entry.name === name);
    if (attempt) return;
    setSelectedName(name); setValue(next ? initialValue(next.input_schema) : null); setConfirmed(false); setStatus(''); setFieldErrors({});
  };
  const sendAttempt = async (current: Attempt, definition: CommandDefinition) => {
    if (inFlightRef.current || props.busy) return;
    inFlightRef.current = true;
    setStatus(current.state === 'reserved' ? 'Sending encrypted command…' : 'Reconciling the existing command attempt…');
    try {
      const sent = await props.onSend(definition, current.arguments, current.invocationId, current.catalogFingerprint);
      const settled = { ...current, state: sent.status } satisfies Attempt;
      persistAttempt(settled);
      if (sent.status === 'failed') setStatus('Command was refused before delivery. Verify the outcome before starting a new attempt.');
      else if (sent.status === 'pending') setStatus('Command delivery is pending; reconcile this attempt instead of submitting it again.');
      else if (sent.status === 'indeterminate' || !sent.wire_id) setStatus('Command state is indeterminate; reconcile this attempt or verify its outcome before reset.');
      else setStatus(sent.deduplicated ? 'Existing command attempt reconciled; pending result.' : 'Command accepted and pending result.');
    } catch (error) {
      const unknown = { ...current, state: 'indeterminate' as const };
      persistAttempt(unknown);
      setStatus(error instanceof ApiError
        ? `Command response was not confirmed: ${error.message}. Reconcile this attempt before any reset.`
        : 'Command connection was interrupted; its state is indeterminate. Reconcile this attempt before any reset.');
    } finally { inFlightRef.current = false; }
  };
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!command || unsupported || !confirmed || props.busy || inFlightRef.current || attempt) return;
    const visibleError = Object.values(fieldErrors)[0];
    const validationError = visibleError ?? validateCommandValue(command.input_schema, value);
    if (validationError) { setStatus(`Validation denied: ${validationError}`); return; }
    const next: Attempt = {
      version: 1, recipientCid: props.catalog.recipient_cid, catalogFingerprint: props.catalog.fingerprint,
      command: command.name, arguments: value, invocationId: crypto.randomUUID(), state: 'reserved',
    };
    persistAttempt(next);
    void sendAttempt(next, command);
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
        : command && <Field schema={command.input_schema} name="Arguments" path="Arguments" value={value}
          onChange={setValue} onValidityChange={noteFieldError} />}
      <label className="command-check"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
        Confirm sending this command. It may change data on the recipient.</label>
      <button className="btn primary" disabled={!!unsupported || !confirmed || props.busy || !!attempt || Object.keys(fieldErrors).length > 0}>Send command</button>
      {attempt && <div className="command-attempt" role="status">
        <strong>Saved attempt: {attempt.state}</strong>
        <span className="mono">{attempt.invocationId}</span>
        <div className="command-attempt-actions">
          <button type="button" className="btn" disabled={props.busy}
            onClick={() => void sendAttempt(attempt, { name: attempt.command, input_schema: {} })}>Reconcile saved attempt</button>
          <button type="button" className="linkbtn" onClick={() => {
            if (window.confirm('Only reset after checking the conversation and verifying this attempt cannot still execute. Continue?')) {
              persistAttempt(null); setStatus('Saved attempt reset after explicit verification.'); setConfirmed(false);
            }
          }}>Reset after verifying outcome</button>
        </div>
      </div>}
      <div className="command-status" role="status" aria-live="polite">{status}</div>
    </>}
  </form>;
}
