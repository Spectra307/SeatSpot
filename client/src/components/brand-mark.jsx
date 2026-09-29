import { Armchair } from 'lucide-react';

export function BrandMark({ compact = false }) {
  return <div className="flex items-center gap-2.5">
    <span className="grid size-9 place-items-center rounded-lg bg-primary text-primary-foreground"><Armchair size={19} strokeWidth={2.3} /></span>
    {!compact && <span className="text-[17px] font-bold">seat<span className="text-primary">spot</span></span>}
  </div>;
}