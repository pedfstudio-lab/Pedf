import type { ReactNode, SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

/** A plain line icon in the text colour. Decorative: the button or label next to it carries the words. */
export function LineIcon({ children, ...props }: IconProps & { readonly children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export function MicIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0" />
      <path d="M12 17.5V21" />
      <path d="M8.5 21h7" />
    </LineIcon>
  );
}

export function ChatIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <path d="M5 4h14a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-8l-5 4v-4H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" />
      <path d="M8 8.5h8" />
      <path d="M8 12h5" />
    </LineIcon>
  );
}

export function LockIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <rect x="5" y="10.5" width="14" height="10" rx="2" />
      <path d="M8 10.5v-3a4 4 0 0 1 8 0v3" />
    </LineIcon>
  );
}

export function UnlockIcon(props: IconProps) {
  return (
    <LineIcon {...props}>
      <rect x="5" y="10.5" width="14" height="10" rx="2" />
      <path d="M8 10.5v-3a4 4 0 0 1 7.6-1.7" />
    </LineIcon>
  );
}
