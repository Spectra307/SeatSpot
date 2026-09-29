import { cn } from '../../lib/utils.js';

export function Field({ className, ...props }) {
  return <div className={cn('grid gap-2', className)} {...props} />;
}

export function Label({ className, ...props }) {
  return <label className={cn('text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70', className)} {...props} />;
}