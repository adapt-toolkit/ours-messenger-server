export type AppRoute =
  | { name: 'chats'; contactCid: string | null }
  | { name: 'not_found'; pathname: string };

export function parseRoute(pathname: string): AppRoute {
  if (pathname === '/' || pathname === '/chats' || pathname === '/chats/') {
    return { name: 'chats', contactCid: null };
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
