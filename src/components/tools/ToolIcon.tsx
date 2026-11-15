import type { ReactNode } from 'react';
import { LineIcon, LockIcon, UnlockIcon } from '../LineIcons';

/** Line drawings for the Tools page, one per tool (by its address name). */
const DRAWINGS: Record<string, ReactNode> = {
  edit: <><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="M13.5 6.5l4 4" /></>,
  merge: <><path d="M5 4l7 7 7-7" /><path d="M12 11v9" /></>,
  split: <><circle cx="6" cy="7" r="2.5" /><circle cx="6" cy="17" r="2.5" /><path d="M8.2 8.4L20 17" /><path d="M8.2 15.6L20 7" /></>,
  compress: <><path d="M4 9h5V4" /><path d="M20 9h-5V4" /><path d="M4 15h5v5" /><path d="M20 15h-5v5" /></>,
  rotate: <><path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" /><path d="M19.5 4v4h-4" /></>,
  watermark: <path d="M12 3.5c3.5 4.2 6 7.4 6 10.5a6 6 0 0 1-12 0c0-3.1 2.5-6.3 6-10.5z" />,
  organize: <><rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="7" rx="1.5" /><rect x="4" y="13" width="7" height="7" rx="1.5" /><rect x="13" y="13" width="7" height="7" rx="1.5" /></>,
  'pdf-to-jpg': <><rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="8.5" cy="10" r="1.5" /><path d="M21 16l-5-5-8 8" /></>,
  'jpg-to-pdf': <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><path d="M8 17l3-3 2 2 1.5-1.5L17 17" /></>,
  repair: <><rect x="4" y="4" width="16" height="16" rx="4" /><path d="M12 8v8" /><path d="M8 12h8" /></>,
  sign: <><path d="M3 17c3-6 5-9 6.5-9 1.8 0-1.5 9 .5 9 1.5 0 2.5-3 3.5-3s1 3 2.5 3H21" /><path d="M3 21h18" /></>,
  upload: <><path d="M12 16V4" /><path d="M7 9l5-5 5 5" /><path d="M5 20h14" /></>,
};

/** Any tool without its own drawing: a plain page. */
const PAGE = <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><path d="M9 13h6" /><path d="M9 17h4" /></>;

export function ToolIcon({ name }: { readonly name: string }) {
  if (name === 'lock') return <LockIcon />;
  if (name === 'unlock') return <UnlockIcon />;
  return <LineIcon>{DRAWINGS[name] ?? PAGE}</LineIcon>;
}
