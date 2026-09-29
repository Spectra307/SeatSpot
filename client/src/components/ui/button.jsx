import { forwardRef } from 'react';
import { cn } from '../../lib/utils.js';

const variants = {
  default: 'bg-primary text-primary-foreground hover:bg-primary/90',
  secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
  outline: 'border border-input bg-background hover:bg-accent hover:text-accent-foreground',
  ghost: 'hover:bg-accent hover:text-accent-foreground',
  destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
};

const sizes = {
  default: 'h-10 px-4 py-2',
  sm: 'h-9 px-3 rounded-md',
  lg: 'h-11 px-7 rounded-lg',
  icon: 'h-10 w-10'
};

export const Button = forwardRef(function Button({ className, variant = 'default', size = 'default', ...props }, ref) {
  return <button ref={ref} className={cn('inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50', variants[variant], sizes[size], className)} {...props} />;
});