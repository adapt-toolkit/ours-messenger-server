import { Icon } from './icons';

export function SearchInput({ value, onChange, placeholder, label = placeholder }: { value: string; onChange: (value: string) => void; placeholder: string; label?: string }) {
  return <div className="search adaptive-search" role="search"><span className="adaptive-search-icon" aria-hidden><Icon name="search" /></span><input className="field" aria-label={label} placeholder={placeholder} value={value} onChange={event => onChange(event.target.value)} onKeyDown={event => { if(event.key === 'Escape') { event.preventDefault(); onChange(''); } }} /></div>;
}
