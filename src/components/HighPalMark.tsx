/**
 * The HighPal mark: four quarter-circles forming a circle, the bottom-right one turned
 * outward. Drawn in the current text colour, so it follows the page (dark forest by default).
 * public/favicon.svg and the share/app icons use the same shapes.
 */
export function HighPalMark({ className }: { readonly className?: string }) {
  return (
    <svg
      viewBox="0 0 100 100"
      className={className}
      fill="currentColor"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M45.5 45.5H1.5A44 44 0 0 1 45.5 1.5Z" />
      <path d="M54.5 45.5V1.5A44 44 0 0 1 98.5 45.5Z" />
      <path d="M45.5 54.5H1.5A44 44 0 0 0 45.5 98.5Z" />
      <path d="M98.5 98.5H54.5A44 44 0 0 1 98.5 54.5Z" />
    </svg>
  );
}
