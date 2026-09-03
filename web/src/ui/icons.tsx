import { CSSProperties, ComponentType } from 'react';
import {
  ArrowLeft,
  Bolt,
  Bot,
  Boxes,
  Check,
  ChevronDown,
  ChevronRight,
  CirclePause,
  CirclePlay,
  Copy,
  Download,
  Eye,
  Grid2X2,
  Inbox,
  Link2,
  LockKeyhole,
  MessageCircleReply,
  MessageSquareText,
  Mic,
  Maximize2,
  Menu,
  Minus,
  MoreHorizontal,
  Paperclip,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  SendHorizontal,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  UserRound,
  UserRoundPlus,
  X,
  type LucideProps,
} from 'lucide-react';

const ICONS: Record<string, ComponentType<LucideProps>> = {
  app: Grid2X2,
  back: ArrowLeft,
  bolt: Bolt,
  chat: MessageSquareText,
  check: Check,
  chevron: ChevronRight,
  chevronDown: ChevronDown,
  close: X,
  clusters: Boxes,
  copy: Copy,
  download: Download,
  edit: Pencil,
  inbox: Inbox,
  link: Link2,
  lock: LockKeyhole,
  mic: Mic,
  maximize: Maximize2,
  menu: Menu,
  minus: Minus,
  monitor: Eye,
  monitorEye: Eye,
  more: MoreHorizontal,
  paperclip: Paperclip,
  pause: CirclePause,
  play: CirclePlay,
  plus: Plus,
  refresh: RefreshCw,
  reply: MessageCircleReply,
  search: Search,
  send: SendHorizontal,
  settings: Settings2,
  shield: ShieldCheck,
  sliders: SlidersHorizontal,
  trash: Trash2,
  user: UserRound,
  invite: UserRoundPlus,
  agent: Bot,
  network: Boxes,
};

export function Icon(props: {
  name: keyof typeof ICONS | string;
  size?: number;
  stroke?: number;
  fill?: boolean;
  style?: CSSProperties;
  className?: string;
}) {
  const { name, size = 18, stroke = 1.8, fill = false, style, className } = props;
  const Glyph = ICONS[name];
  if (!Glyph) return null;
  return (
    <Glyph
      className={'ic ' + (className || '')}
      width={size}
      height={size}
      strokeWidth={stroke}
      fill={fill ? 'currentColor' : 'none'}
      style={style}
      aria-hidden="true"
    />
  );
}
