import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
export { Button } from '../ui/Button';
import { Button } from '../ui/Button';
import { SearchInput } from '../ui/SearchInput';
export function Row({ title, subtitle, onClick, avatar, end, selected }: { title: string; subtitle?: string; onClick?: () => void; avatar?: string; end?: ReactNode; selected?: boolean }) { const body = <><span className="fleet-avatar contact-avatar" aria-hidden>{avatar ?? title.split(' ').map(x => x[0]).join('').slice(0, 2)}</span><span className="fleet-row-copy contact-copy"><strong className="contact-name">{title}</strong>{subtitle && <small className="contact-last">{subtitle}</small>}</span>{end ?? (onClick && <ChevronRight size={16} />)}</>; return onClick ? <button className={selected === undefined ? 'fleet-row contact-row' : 'fleet-row contact-row' + (selected ? ' active' : '')} aria-current={selected || undefined} onClick={onClick}>{body}{selected && <span className="contact-active-glow" aria-hidden />}</button> : <div className="fleet-row contact-row">{body}</div>; }
export function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="fleet-field"><span>{label}</span>{isValidElement(children) ? cloneElement(children as ReactElement<{ 'aria-label'?: string; className?: string }>, { 'aria-label': label, className: 'field' }) : children}</label>; }
export function SearchField(props: { value: string; onChange: (v: string) => void; placeholder: string }) { return <SearchInput {...props} />; }
export function PageHeader({ title, subtitle, onBack, actions }: { title: string; subtitle?: string; onBack?: () => void; actions?: ReactNode }) { return <header className="fleet-page-heading"><div>{onBack && <Button onClick={onBack}>‹ Back</Button>}<h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div><div className="fleet-actions">{actions}</div></header>; }

export { MenuAction } from '../ui/MenuAction';
