import { cn } from '../../lib/utils.js';

export function Alert({ className, variant = 'default', ...props }) {
  return <div role="alert" className={cn('relative w-full rounded-md border px-4 py-3 text-sm', variant === 'destructive' ? 'border-destructive/40 bg-destructive/5 text-destructive' : 'border-border bg-card text-card-foreground', className)} {...props} />;
}

export function AlertTitle({ className, ...props }) {
  return <h3 className={cn('mb-1 font-semibold leading-none', className)} {...props} />;
}

export function AlertDescription({ className, ...props }) {
  return <div className={cn('text-sm opacity-90', className)} {...props} />;
}