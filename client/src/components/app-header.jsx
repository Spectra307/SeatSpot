import { Armchair, CalendarClock, LogOut, Search } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/auth-context.jsx';
import { Button } from './ui/button.jsx';

export function AppHeader({ active = 'restaurants' }) {
  const { claims, logout } = useAuth();
  const navigate = useNavigate();
  const displayName = String(claims?.name ?? '').trim() || 'Your account';
  const roleLabel = claims?.role === 'staff' ? 'Restaurant staff' : 'Customer';

  function signOut() {
    logout();
    navigate('/auth', { replace: true });
  }

  return <header className="app-header">
    <div className="app-header-inner">
      <Link to="/restaurants" className="flex items-center gap-2.5 no-underline">
        <span className="grid size-9 place-items-center rounded-lg bg-primary text-primary-foreground"><Armchair size={19} /></span>
        <span className="text-[17px] font-bold">seat<span className="text-primary">spot</span></span>
      </Link>
      <nav className="app-nav" aria-label="Main navigation">
        <Link className={active === 'restaurants' ? 'active' : ''} to="/restaurants"><Search size={15} /> Find a table</Link>
        {claims?.role !== 'staff' && <Link className={active === 'bookings' ? 'active' : ''} to="/bookings"><CalendarClock size={15} /> My bookings</Link>}
        {claims?.role === 'staff' && <Link className={active === 'staff' ? 'active' : ''} to={`/staff/${claims.restaurantId}`}>Staff operations</Link>}
      </nav>
      <div className="app-user">
        <span className="user-avatar" aria-hidden="true">{displayName.slice(0, 1).toUpperCase()}</span>
        <span className="user-identity">
          <strong>{displayName}</strong>
          <small>{roleLabel}</small>
        </span>
        <Button variant="ghost" size="icon" aria-label="Sign out" title="Sign out" onClick={signOut}><LogOut size={17} /></Button>
      </div>
    </div>
  </header>;
}
