import { cn } from '../../lib/utils.js';

export function Surface({ className, ...props }) {
  return <div className={cn('rounded-lg border bg-card shadow-sm', className)} {...props} />;
}