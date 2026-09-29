import { cn } from '../../lib/utils.js';

const variants = {
  default: 'border-transparent bg-primary/10 text-primary',
  secondary: 'border-transparent bg-secondary text-secondary-foreground',
  outline: 'border-border text-foreground',
  success: 'border-transparent bg-emerald-100 text-emerald-800',
  warning: 'border-transparent bg-amber-100 text-amber-800',
  muted: 'border-transparent bg-muted text-muted-foreground'
};

export function Badge({ className, variant = 'default', ...props }) {
  return <span className={cn('inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold transition-colors', variants[variant], className)} {...props} />;
}