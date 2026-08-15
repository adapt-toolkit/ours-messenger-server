import { ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Icon } from './icons';

export default function DialogShell(props: {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  tabs?: ReactNode;
  wide?: boolean;
  className?: string;
}) {
  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) props.onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-backdrop" />
        <Dialog.Content className={'modal' + (props.wide ? ' modal-wide' : '') + (props.className ? ` ${props.className}` : '')}>
          <div className="modal-head">
            <div>
              <Dialog.Title asChild>
                <h3>{props.title}</h3>
              </Dialog.Title>
              {props.description && (
                <Dialog.Description className="modal-description">
                  {props.description}
                </Dialog.Description>
              )}
            </div>
            <Dialog.Close asChild>
              <button className="icon-btn" aria-label={`Close ${props.title}`}>
                <Icon name="close" />
              </button>
            </Dialog.Close>
          </div>
          {props.tabs}
          <div className="modal-body">{props.children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
