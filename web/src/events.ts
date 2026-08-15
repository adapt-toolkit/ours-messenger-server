import type { ConnectionState, ServerEvent } from './types.js';

export const LIVE_EVENT_NAME = 'ours-messenger-live-event';

export function dispatchLiveEvent(event: ServerEvent): void {
  window.dispatchEvent(new CustomEvent<ServerEvent>(LIVE_EVENT_NAME, { detail: event }));
}

export function listenLiveEvents(onEvent: (event: ServerEvent) => void): () => void {
  const listener = (raw: Event) => {
    const event = (raw as CustomEvent<ServerEvent>).detail;
    if (event?.v === 1) onEvent(event);
  };
  window.addEventListener(LIVE_EVENT_NAME, listener);
  return () => window.removeEventListener(LIVE_EVENT_NAME, listener);
}

export function connectEvents(
  onEvent: (event: ServerEvent) => void,
  onState: (state: ConnectionState) => void,
): () => void {
  const source = new EventSource('/api/events');
  let opened = false;
  onState('connecting');
  source.onopen = () => {
    opened = true;
    onState('live');
  };
  source.onerror = () => onState(opened ? 'retrying' : 'connecting');

  const bind = (type: ServerEvent['type']) => {
    source.addEventListener(type, (raw) => {
      try {
        const parsed = JSON.parse((raw as MessageEvent).data) as Omit<ServerEvent, 'type'>;
        if (parsed && parsed.v === 1) onEvent({ ...parsed, type } as ServerEvent);
      } catch {
        // A malformed hint is not canonical state. The EventSource stays alive;
        // its next connected sync or an explicit user action rebuilds from REST.
      }
    });
  };
  bind('sync_required');
  bind('message_received');
  bind('receipt_received');
  bind('file_received');
  return () => source.close();
}
