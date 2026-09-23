import { useId, type ButtonHTMLAttributes } from 'react';
import { ChevronRight, type LucideIcon } from 'lucide-react';
import { Button } from './Button';
import './MenuAction.css';

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title' | 'children'> & {
  title: string;
  description?: string;
  icon: LucideIcon;
  danger?: boolean;
};

/** An action in a menu, using the same button surface as the rest of the app. */
export function MenuAction({ title, description, icon: Icon, danger = false, className = '', ...props }: Props) {
  const labelId = useId();
  const descriptionId = useId();
  return <Button aria-labelledby={description ? labelId : undefined} aria-describedby={description ? descriptionId : undefined} {...props} className={['menu-action', danger && 'danger', className].filter(Boolean).join(' ')}>
    <Icon size={20} aria-hidden />
    <span><span id={labelId}>{title}</span>{description && <small id={descriptionId} className="menu-action-description">{description}</small>}</span>
    <ChevronRight size={16} aria-hidden />
  </Button>;
}
