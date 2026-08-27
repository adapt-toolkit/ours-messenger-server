import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type ClipboardEvent,
  type KeyboardEvent,
} from 'react';

export function useIOSContentEditable(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iPhone|iPad|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function insertPlainText(editor: HTMLElement, text: string) {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !editor.contains(selection.anchorNode)) {
    editor.append(document.createTextNode(text));
    return;
  }
  const range = selection.getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

export const ComposerEditor = forwardRef<HTMLDivElement, {
  value: string;
  placeholder: string;
  busy: boolean;
  onChange: (value: string) => void;
  onSend: () => void;
}>(function ComposerEditor({ value, placeholder, busy, onChange, onSend }, forwardedRef) {
  const ref = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  useImperativeHandle(forwardedRef, () => ref.current as HTMLDivElement, []);

  useLayoutEffect(() => {
    const editor = ref.current;
    if (editor && !composing.current && editor.textContent !== value) editor.textContent = value;
  }, [value]);

  const read = () => onChange(ref.current?.textContent ?? '');
  const paste = (event: ClipboardEvent<HTMLDivElement>) => {
    event.preventDefault();
    insertPlainText(event.currentTarget, event.clipboardData.getData('text/plain'));
    read();
  };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (!event.shiftKey) onSend();
    else {
      insertPlainText(event.currentTarget, '\n');
      read();
    }
  };

  return (
    <div
      ref={ref}
      className="field composer-editor"
      contentEditable="plaintext-only"
      suppressContentEditableWarning
      role="textbox"
      aria-label={placeholder}
      aria-multiline="true"
      aria-busy={busy}
      data-placeholder={placeholder}
      inputMode="text"
      enterKeyHint="send"
      onInput={read}
      onPaste={paste}
      onKeyDown={keyDown}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={() => { composing.current = false; read(); }}
    />
  );
});
