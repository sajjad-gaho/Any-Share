import type { ComponentProps } from 'react';
import { cn } from '../lib/cn';

/**
 * Placeholder brand mark: two offset rounded screens joined by a link.
 * Replace with the final logo once branding is decided.
 */
export function LogoMark({ className, ...props }: ComponentProps<'svg'>) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      className={cn('size-8', className)}
      {...props}
    >
      <rect width="32" height="32" rx="8" className="fill-primary" />
      <rect
        x="6"
        y="8"
        width="12"
        height="9"
        rx="2"
        className="stroke-primary-foreground"
        strokeWidth="2"
      />
      <rect
        x="14"
        y="15"
        width="12"
        height="9"
        rx="2"
        className="fill-primary stroke-primary-foreground"
        strokeWidth="2"
      />
      <circle cx="20" cy="19.5" r="1.5" className="fill-primary-foreground" />
    </svg>
  );
}
