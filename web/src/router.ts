export type AppRoute =
  | { name: 'chats'; contactCid: string | null }
  | { name: 'contact'; contactCid: string }
  | { name: 'not_found'; pathname: string };

export function parseRoute(pathname: string): AppRoute {
  if (pathname === '/' || pathname === '/chats' || pathname === '/chats/') {
    return { name: 'chats', contactCid: null };
  }
  const contactMatch = /^\/chats\/([^/]+)\/contact\/?$/.exec(pathname);
  if (contactMatch) {
    try {
      const contactCid = decodeURIComponent(contactMatch[1]);
      if (contactCid) return { name: 'contact', contactCid };
    } catch {
      // Invalid URL encoding is an unknown route, never an API request.
    }
  }
  const match = /^\/chats\/([^/]+)\/?$/.exec(pathname);
  if (match) {
    try {
      const contactCid = decodeURIComponent(match[1]);
      if (contactCid) return { name: 'chats', contactCid };
    } catch {
      // Invalid URL encoding is an unknown route, never an API request.
    }
  }
  return { name: 'not_found', pathname };
}

export function chatPath(contactCid?: string | null): string {
  return contactCid ? `/chats/${encodeURIComponent(contactCid)}` : '/chats';
}

export function contactPath(contactCid: string): string {
  return `/chats/${encodeURIComponent(contactCid)}/contact`;
}

/** A contact route opened inside Messenger returns through browser history;
 * a cold deep link replaces itself so Back never exits unexpectedly. */
export function contactReturnMode(historyState: unknown): 'back' | 'replace' {
  return typeof historyState === 'object' && historyState !== null
    && (historyState as { oursMessenger?: unknown }).oursMessenger === true ? 'back' : 'replace';
}
