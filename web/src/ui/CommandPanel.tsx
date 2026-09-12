import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { safePatternError, matchesPattern, patternBudget, PatternBudgetError, type PatternBudget } from './command-pattern.js';
import type { CommandCatalog, CommandDefinition, JsonValue, SendCommandResult } from '../types.js';

const SUPPORTED = new Set([
  'type', 'title', 'description', 'default', 'enum', 'const', 'minimum', 'maximum',
  'minLength', 'maxLength', 'pattern', 'properties', 'required', 'items', 'minItems', 'maxItems',
  'additionalProperties', 'anyOf', 'uniqueItems',
]);
const MAX_DEPTH = 6;
const MAX_CONTROLS = 64;
const MAX_VALUE_DEPTH = 12;
const MAX_VALUE_NODES = 2_048;
const MAX_VALUE_BYTES = 64 * 1024;

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
  if (type === undefined && schema.enum === undefined && !Object.hasOwn(schema, 'const') && schema.anyOf === undefined) {
    return 'An explicit type, enum, or const is required';
  }
  if (schema.anyOf !== undefined) {
    if (!Array.isArray(schema.anyOf) || schema.anyOf.length === 0) return 'anyOf must be a non-empty array of schemas';
    for (let index = 0; index < schema.anyOf.length; index++) {
      const branch = schema.anyOf[index];
      if (!branch || typeof branch !== 'object' || Array.isArray(branch)) return `anyOf[${index}] must be a schema object`;
      const error = schemaError(branch as Schema, depth + 1, count);
      if (error) return `anyOf[${index}]: ${error}`;
    }
  }
  if (schema.uniqueItems !== undefined) {
    if (typeof schema.uniqueItems !== 'boolean') return 'uniqueItems must be boolean';
    if (type !== 'array') return 'uniqueItems requires array type';
  }
  if (type !== undefined && (typeof type !== 'string' || !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(type))) {
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
  if (schema.pattern !== undefined) {
    if (type !== 'string') return 'pattern requires a string type';
    const error = safePatternError(schema.pattern);
    if (error) return error;
  }
  if ((schema.minItems !== undefined || schema.maxItems !== undefined) && type !== 'array') {
    return 'minItems/maxItems require array type';
  }
  if (schema.additionalProperties !== undefined) {
    if (type !== 'object') return 'additionalProperties requires an object type';
    if (schema.additionalProperties === true) return 'additionalProperties: true is not supported';
    if (schema.additionalProperties !== false) {
      return schema.additionalProperties && typeof schema.additionalProperties === 'object'
        && !Array.isArray(schema.additionalProperties)
        ? 'Schema-valued additionalProperties is not supported'
        : 'additionalProperties must be false';
    }
  }
  if ((schema.properties !== undefined || schema.required !== undefined) && type !== 'object') return 'properties/required require object type';
  if (schema.items !== undefined && type !== 'array') return 'items requires array type';
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

function boundedValueError(value: JsonValue, path: string): string | null {
  let nodes = 0;
  const visit = (item: JsonValue, depth: number): string | null => {
    if (depth > MAX_VALUE_DEPTH) return `${path} exceeds depth ${MAX_VALUE_DEPTH}`;
    nodes++;
    if (nodes > MAX_VALUE_NODES) return `${path} exceeds ${MAX_VALUE_NODES} JSON values`;
    if (item === null || typeof item !== 'object') return null;
    for (const child of Array.isArray(item) ? item : Object.values(item)) {
      const error = visit(child, depth + 1);
      if (error) return error;
    }
    return null;
  };
  const structuralError = visit(value, 0);
  if (structuralError) return structuralError;
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_VALUE_BYTES) {
    return `${path} exceeds ${MAX_VALUE_BYTES} UTF-8 bytes`;
  }
  return null;
}

function validateCommandValueInner(schema: Schema, value: JsonValue, path: string, budget: PatternBudget): string | null {
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((branch) =>
    validateCommandValueInner(branch as Schema, value, path, budget) === null)) {
    return `${path} must match at least one anyOf alternative`;
  }
  if (Object.hasOwn(schema, 'const') && !sameJson(schema.const, value)) return `${path} must use the fixed value`;
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => sameJson(option, value))) return `${path} is not an allowed value`;
  if (schema.type === 'null') return value === null ? null : `${path} must be null`;
  if (schema.type === 'boolean') return typeof value === 'boolean' ? null : `${path} must be boolean`;
  if (schema.type === 'string') {
    if (typeof value !== 'string') return `${path} must be text`;
    if (typeof schema.minLength === 'number' && Array.from(value).length < schema.minLength) return `${path} is too short`;
    if (typeof schema.maxLength === 'number' && Array.from(value).length > schema.maxLength) return `${path} is too long`;
    if (schema.pattern !== undefined) {
      if (!matchesPattern(schema.pattern as string, value, budget)) return `${path} does not match the required format`;
    }
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
    if (schema.uniqueItems === true) {
      const seen = new Set<string>();
      for (const item of value) {
        const key = canonicalJson(item);
        if (seen.has(key)) return `${path} must contain unique items`;
        seen.add(key);
      }
    }
    if (schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)) {
      for (let index = 0; index < value.length; index++) {
        const error = validateCommandValueInner(schema.items as Schema, value[index], `${path}[${index}]`, budget);
        if (error) return error;
      }
    }
    return null;
  }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return `${path} must be an object`;
    const properties = (schema.properties ?? {}) as Record<string, JsonValue>;
    for (const key of Object.keys(value)) {
      if (schema.additionalProperties === false && !Object.hasOwn(properties, key)) {
        return `${path}.${key || '(empty key)'} is not declared by the schema`;
      }
    }
    const required = Array.isArray(schema.required) ? schema.required as string[] : [];
    for (const key of required) if (!Object.hasOwn(value, key)) return `${path}.${key || '(empty key)'} is required`;
    for (const [key, child] of Object.entries(properties)) {
      if (!Object.hasOwn(value, key)) continue;
      const error = validateCommandValueInner(child as Schema, value[key], `${path}.${key || '(empty key)'}`, budget);
      if (error) return error;
    }
  }
  return null;
}

export function validateCommandValue(schema: Schema, value: JsonValue, path = 'Arguments'): string | null {
  const unsupported = schemaError(schema);
  if (unsupported) return `${path} cannot be validated safely: ${unsupported}`;
  try {
    return boundedValueError(value, path) ?? validateCommandValueInner(schema, value, path, patternBudget());
  } catch (error) {
    if (error instanceof PatternBudgetError) return `${path} cannot be validated safely: ${error.message}`;
    throw error;
  }
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function fieldType(schema: Schema): JsonValue | undefined {
  if (schema.type !== undefined) return schema.type;
  if (Array.isArray(schema.anyOf) && schema.anyOf.length) {
    const types = schema.anyOf.map(branch => fieldType(branch as Schema));
    if (types.every(type => type === types[0]) && ['string', 'number', 'integer', 'boolean', 'null'].includes(String(types[0]))) return types[0];
  }
  return undefined;
}

function initialValue(schema: Schema): JsonValue {
  if (Object.hasOwn(schema, 'const')) return schema.const;
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if (Array.isArray(schema.anyOf) && schema.anyOf.length && !schema.type) return initialValue(schema.anyOf[0] as Schema);
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

function JsonField(props: {
  schema: Schema; label: string; path: string; value: JsonValue; required?: boolean;
  description?: string; arrayOnly?: boolean; onChange(value: JsonValue): void; onValidityChange(path: string, error: string | null): void;
}) {
  const { schema, label, path, value, required, description, arrayOnly, onChange, onValidityChange } = props;
  const generatedId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const pathId = path.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-|-$/g, '') || 'root';
  const helpId = `command-json-${pathId}-${generatedId}-help`;
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
    if (arrayOnly && !Array.isArray(parsed)) {
      const nextError = `${label} must be a JSON array`;
      setError(nextError); onValidityChange(path, nextError); return;
    }
    const nextError = validateCommandValue(schema, parsed as JsonValue, label);
    setError(nextError); onValidityChange(path, nextError);
    lastEmitted.current = JSON.stringify(parsed);
    onChange(parsed as JsonValue);
  };

  return <label className="command-field"><span>{label}{required ? ' *' : ''}</span>
    <textarea value={raw} rows={3} aria-describedby={helpId} aria-invalid={error ? 'true' : undefined}
      onChange={(event) => update(event.target.value)} />
    <small id={helpId}>{description ?? (arrayOnly ? 'JSON array' : 'JSON value matching any allowed alternative')}</small>
    {error && <span className="command-field-error" role="alert">{error}</span>}
  </label>;
}

function ScalarField(props: {
  schema: Schema; label: string; path: string; value: JsonValue; required?: boolean;
  description?: string; numeric: boolean;
  onChange(value: JsonValue): void; onValidityChange(path: string, error: string | null): void;
}) {
  const { schema, label, path, value, required, description, numeric, onChange, onValidityChange } = props;
  const error = validateCommandValue(schema, value, label);
  useEffect(() => {
    onValidityChange(path, error);
    return () => onValidityChange(path, null);
  }, [error, onValidityChange, path]);
  return <label className="command-field"><span>{label}{required ? ' *' : ''}</span>
    <input type={numeric ? 'number' : 'text'} value={String(value ?? '')}
      min={typeof schema.minimum === 'number' ? schema.minimum : undefined}
      max={typeof schema.maximum === 'number' ? schema.maximum : undefined}
      step={fieldType(schema) === 'integer' ? 1 : numeric ? 'any' : undefined}
      required={required} aria-invalid={error ? 'true' : undefined}
      onChange={(event) => onChange(numeric ? Number(event.target.value) : event.target.value)} />
    {description && <small>{description}</small>}
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
  if (Object.hasOwn(schema, 'const')) {
    return <div className="command-field"><span>{label}{required ? ' *' : ''}</span>
      <small>Fixed value: {JSON.stringify(schema.const)}</small></div>;
  }
  if (Array.isArray(schema.enum)) {
    return <label className="command-field"><span>{label}{required ? ' *' : ''}</span>
      <select value={JSON.stringify(value)} onChange={(event) => onChange(JSON.parse(event.target.value))}>
        {schema.enum.map((option, index) => <option key={index} value={JSON.stringify(option)}>{String(option)}</option>)}
      </select>{description && <small>{description}</small>}</label>;
  }
  const type = fieldType(schema);
  if (schema.anyOf && (type === undefined || type === 'object' || type === 'array')) {
    return <JsonField schema={schema} label={label} path={path} value={value} required={required}
      description={description} onChange={onChange} onValidityChange={onValidityChange} />;
  }
  if (type === 'object') {
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
  if (type === 'array') {
    return <JsonField arrayOnly schema={schema} label={label} path={path} value={value} required={required}
      description={description} onChange={onChange} onValidityChange={onValidityChange} />;
  }
  if (type === 'boolean') {
    return <label className="command-check"><input type="checkbox" checked={value === true} onChange={(event) => onChange(event.target.checked)} /> {label}</label>;
  }
  if (type === 'null') return <div className="command-field"><span>{label}</span><small>Null value</small></div>;
  const numeric = type === 'number' || type === 'integer';
  return <ScalarField schema={schema} label={label} path={path} value={value} required={required}
    description={description} numeric={numeric} onChange={onChange} onValidityChange={onValidityChange} />;
}

export function CommandPanel(props: {
  catalog: CommandCatalog;
  recipientName: string;
  initialCommandName?: string;
  busy: boolean;
  onRefresh(): void;
  onClose(): void;
  onSend(command: CommandDefinition, args: JsonValue, invocationId: string, catalogFingerprint: string): Promise<SendCommandResult>;
}) {
  const firstCommand = props.catalog.commands.find((entry) => entry.name === props.initialCommandName) ?? props.catalog.commands[0];
  const [selectedName, setSelectedName] = useState(firstCommand?.name ?? '');
  const command = props.catalog.commands.find((entry) => entry.name === selectedName) ?? firstCommand;
  const unsupported = useMemo(() => command ? schemaError(command.input_schema) : null, [command]);
  const [value, setValue] = useState<JsonValue>(() => firstCommand && !unsupported ? initialValue(firstCommand.input_schema) : null);
  const [status, setStatus] = useState('');
  const [statusTone, setStatusTone] = useState<'idle' | 'pending' | 'warning' | 'error' | 'success' | 'indeterminate'>('idle');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const latestSendRef = useRef(0);
  const noteFieldError = useCallback((path: string, error: string | null) => {
    setFieldErrors((current) => {
      if (error === null) {
        if (!Object.hasOwn(current, path)) return current;
        const next = { ...current }; delete next[path]; return next;
      }
      return current[path] === error ? current : { ...current, [path]: error };
    });
  }, []);
  const choose = (name: string) => {
    const next = props.catalog.commands.find((entry) => entry.name === name);
    setSelectedName(name); setValue(next && !schemaError(next.input_schema) ? initialValue(next.input_schema) : null); setStatus(''); setStatusTone('idle'); setFieldErrors({});
  };
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!command || unsupported || props.busy) return;
    const visibleError = Object.values(fieldErrors)[0];
    const validationError = visibleError ?? validateCommandValue(command.input_schema, value);
    if (validationError) { setStatus(`Validation denied: ${validationError}`); setStatusTone('error'); return; }
    const sequence = ++latestSendRef.current;
    const sentCommand = command;
    const sentArguments = value;
    setValue(initialValue(sentCommand.input_schema)); setFieldErrors({});
    setStatus(`Sending ${sentCommand.name}…`); setStatusTone('pending');
    void props.onSend(sentCommand, sentArguments, crypto.randomUUID(), props.catalog.fingerprint).then((sent) => {
      if (latestSendRef.current !== sequence) return;
      if (sent.status === 'failed') { setStatus(`${sentCommand.name} was refused before delivery.`); setStatusTone('error'); }
      else if (sent.status === 'pending') { setStatus(`${sentCommand.name} delivery is pending.`); setStatusTone('warning'); }
      else if (sent.status === 'indeterminate' || !sent.wire_id) { setStatus(`${sentCommand.name} delivery could not be confirmed.`); setStatusTone('indeterminate'); }
      else { setStatus(`${sentCommand.name} sent. Its result will appear in the conversation.`); setStatusTone('success'); }
    }).catch(() => {
      if (latestSendRef.current !== sequence) return;
      setStatus(`${sentCommand.name} could not be sent. You can try it again.`); setStatusTone('error');
    });
  };
  const validationError = command && !unsupported ? validateCommandValue(command.input_schema, value) : null;
  return <form noValidate className="command-panel" aria-label="Send a typed command" onSubmit={submit}
    onKeyDown={(event) => { if (event.key === 'Escape') props.onClose(); }}>
    <div className="command-panel-head"><div className="command-panel-recipient"><strong>Commands for {props.recipientName}</strong>
      <span className="mono" title={props.catalog.recipient_cid}>{props.catalog.recipient_cid.slice(0, 12)}…</span></div>
      <button type="button" className="linkbtn" onClick={props.onRefresh}>Refresh</button>
      <button type="button" className="icon-btn" aria-label="Close commands" onClick={props.onClose}>×</button></div>
    {props.catalog.commands.length === 0 ? <p role="status">This recipient does not advertise commands.</p> : <>
      <label className="command-field"><span>Command</span><select autoFocus value={selectedName} onChange={(event) => choose(event.target.value)}>
        {props.catalog.commands.map((entry) => <option key={entry.name} value={entry.name}>{entry.name}</option>)}
      </select></label>
      {command?.description && <p>{command.description}</p>}
      {unsupported ? <div className="banner error" role="alert">Cannot render this command safely: {unsupported}</div>
        : command && <Field key={command.name} schema={command.input_schema} name="Arguments" path="Arguments" value={value}
          onChange={setValue} onValidityChange={noteFieldError} />}
      {validationError?.includes('cannot be validated safely')
        && !Object.values(fieldErrors).some(error => error.includes('cannot be validated safely'))
        && <div className="banner error" role="alert">{validationError}</div>}
      {command && <button className="btn primary" disabled={!!unsupported || props.busy || !!validationError || Object.keys(fieldErrors).length > 0}>Send command</button>}
      <div className={`command-status ${statusTone}`} data-state={statusTone} role="status" aria-live="polite">{status}</div>
    </>}
  </form>;
}
