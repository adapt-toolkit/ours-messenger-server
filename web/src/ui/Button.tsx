import type { ButtonHTMLAttributes } from 'react';

type Props = ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean };

/** Shared Messenger controls; appearance comes from the existing theme cascade. */
export function Button({ primary, className = '', type = 'button', ...props }: Props) {
  return <button type={type} className={['btn', primary && 'primary', className].filter(Boolean).join(' ')} {...props} />;
}
export function IconButton({ className = '', type = 'button', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type={type} className={['icon-btn', className].filter(Boolean).join(' ')} {...props} />;
}

export function TextButton({ className = '', type = 'button', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type={type} className={['linkbtn', className].filter(Boolean).join(' ')} {...props} />;
}
