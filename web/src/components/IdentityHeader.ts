import type { ConnectionState, IdentityView } from '../types.js';
import { button, element } from './dom.js';

export function IdentityHeader(identity: IdentityView | null, connection: ConnectionState, openInvite: () => void): HTMLElement {
  const header = element('header', 'identity-header');
  const brand = element('div', 'brand');
  brand.append(element('span', 'brand-mark', 'ours'), element('span', 'brand-product', 'messenger'));
  const identityBlock = element('div', 'identity-block');
  identityBlock.append(
    element('strong', '', identity?.name ?? 'Connecting…'),
    element('span', 'identity-cid', identity?.cid ? `${identity.cid.slice(0, 12)}…` : ''),
  );
  const status = element('span', `connection connection-${connection}`, connection === 'live' ? 'Live' : connection === 'retrying' ? 'Reconnecting' : 'Connecting');
  status.setAttribute('role', 'status');
  header.append(brand, identityBlock, status, button('Add contact', 'primary compact', openInvite));
  return header;
}
