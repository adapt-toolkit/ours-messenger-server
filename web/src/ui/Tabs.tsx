import type { KeyboardEvent } from 'react';

export interface TabOption<T extends string> {
  id: T;
  label: string;
  count?: number;
}

export function Tabs<T extends string>(props: {
  label: string;
  options: readonly TabOption<T>[];
  value: T;
  onChange: (value: T) => void;
  idPrefix: string;
  panelId: string;
  className?: string;
}) {
  const move = (event: KeyboardEvent<HTMLButtonElement>, currentIndex: number) => {
    const { key } = event;
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(key)) return;
    event.preventDefault();
    const last = props.options.length - 1;
    const next = key === 'Home'
      ? 0
      : key === 'End'
        ? last
        : key === 'ArrowLeft' || key === 'ArrowUp'
          ? (currentIndex - 1 + props.options.length) % props.options.length
          : (currentIndex + 1) % props.options.length;
    const option = props.options[next];
    if (!option) return;
    props.onChange(option.id);
    document.getElementById(`${props.idPrefix}-${option.id}`)?.focus();
  };

  return (
    <div className={props.className} role="tablist" aria-label={props.label}>
      {props.options.map((option, index) => (
        <button
          key={option.id}
          id={`${props.idPrefix}-${option.id}`}
          type="button"
          role="tab"
          aria-selected={props.value === option.id}
          aria-controls={props.panelId}
          tabIndex={props.value === option.id ? 0 : -1}
          className={'tab' + (props.value === option.id ? ' active' : '')}
          onClick={() => props.onChange(option.id)}
          onKeyDown={(event) => move(event, index)}
        >
          {option.label}{option.count === undefined ? null : <> <span>{option.count}</span></>}
        </button>
      ))}
    </div>
  );
}
