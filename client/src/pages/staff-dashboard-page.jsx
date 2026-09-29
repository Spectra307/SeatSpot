import { useCallback, useEffect, useMemo, useState } from 'react';
import { io } from 'socket.io-client';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowDownToLine, Armchair, Check, CircleAlert, Clock3, LoaderCircle, RefreshCw, Users } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../auth/auth-context.jsx';
import { AppHeader } from '../components/app-header.jsx';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert.jsx';
import { Badge } from '../components/ui/badge.jsx';
import { Button } from '../components/ui/button.jsx';
import { Card, CardContent } from '../components/ui/card.jsx';
import { Field, Label } from '../components/ui/field.jsx';
import { Input } from '../components/ui/input.jsx';
import { api } from '../lib/api.js';

const statusMeta = {
  available: { title: 'Available', color: 'available', sub: 'Ready to seat' },
  reserved: { title: 'Reserved', color: 'reserved', sub: 'Booking confirmed' },
  occupied: { title: 'Occupied', color: 'occupied', sub: 'In service' },
  unavailable: { title: 'Unavailable', color: 'unavailable', sub: 'Out of service' }
};

function displayGuest(userId) {
  return `Guest Â· ${String(userId).slice(-6)}`;
}

export function StaffDashboardPage() {
  const { restaurantId } = useParams();
  const { token, claims } = useAuth();
  const navigate = useNavigate();
  const [tables, setTables] = useState([]);
  const [queue, setQueue] = useState([]);
  const [queueLength, setQueueLength] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busyTable, setBusyTable] = useState('');
  const [guestName, setGuestName] = useState('Walk-in Guest');
  const [partySize, setPartySize] = useState(2);
  const [walkInTable, setWalkInTable] = useState(null);
  const [error, setError] = useState(null);
  const [socketLive, setSocketLive] = useState(false);

  const counts = useMemo(() => tables.reduce((total, table) => {
    total[table.status] = (total[table.status] ?? 0) + 1;
    return total;
  }, { available: 0, reserved: 0, occupied: 0, unavailable: 0 }), [tables]);

  const refreshTables = useCallback(async () => {
    const result = await api(`/restaurants/${restaurantId}/dashboard/tables`);
    setTables(result.tables ?? []);
  }, [restaurantId]);

  const refreshQueue = useCallback(async () => {
    const result = await api(`/restaurants/${restaurantId}/dashboard/queue`);
    setQueue(result.queue ?? []);
    setQueueLength(result.queueLength ?? 0);
  }, [restaurantId]);

  const refreshAll = useCallback(async () => {
    await Promise.all([refreshTables(), refreshQueue()]);
  }, [refreshQueue, refreshTables]);

  useEffect(() => {
    if (claims?.role !== 'staff' || String(claims.restaurantId).toLowerCase() !== restaurantId.toLowerCase()) {
      setLoading(false);
      return;
    }
    let active = true;
    refreshAll().catch((requestError) => {
      if (active) setError(requestError.message || 'Could not load dashboard.');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [claims?.role, claims?.restaurantId, restaurantId, refreshAll]);

  useEffect(() => {
    if (claims?.role !== 'staff' || String(claims.restaurantId).toLowerCase() !== restaurantId.toLowerCase() || !token) return undefined;
    const socket = io(window.location.origin, { auth: { token }, transports: ['websocket', 'polling'] });
    socket.on('connect', () => setSocketLive(true));
    socket.on('disconnect', () => setSocketLive(false));
    socket.on('connect_error', (connectError) => {
      setSocketLive(false);
      if (/invalid|expired/i.test(connectError.message)) navigate('/auth?reason=expired', { replace: true });
    });
    socket.on('availability:update', (event) => {
      if (event.restaurantId === restaurantId) void refreshTables();
    });
    socket.on('queue:update', (event) => {
      if (event.restaurantId === restaurantId) {
        setQueue(event.payload?.queue ?? []);
        setQueueLength(event.payload?.queueLength ?? event.payload?.queue?.length ?? 0);
      }
    });
    return () => socket.disconnect();
  }, [claims?.role, claims?.restaurantId, restaurantId, token, navigate, refreshTables]);

  async function updateStatus(table, status) {
    setBusyTable(table._id);
    setError(null);
    try {
      await api(`/restaurants/${restaurantId}/dashboard/tables/${table._id}/status`, {
        method: 'PATCH', body: JSON.stringify({ status })
      });
      toast.success(`${table.label} marked ${status}`);
      await refreshTables();
    } catch (requestError) {
      const message = requestError.status === 409
        ? 'This table has an active booking and cannot be reopened.'
        : requestError.status === 401
          ? 'Your session expired. Sign in again.'
          : requestError.message;
      setError(message);
      toast.error(message);
      if (requestError.status === 401) navigate('/auth?reason=expired', { replace: true });
    } finally {
      setBusyTable('');
    }
  }

  async function seatWalkIn(event) {
    event.preventDefault();
    if (!walkInTable) return;
    setBusyTable(walkInTable._id);
    setError(null);
    try {
      await api(`/restaurants/${restaurantId}/dashboard/tables/${walkInTable._id}/walk-in`, {
        method: 'POST',
        body: JSON.stringify({ guestName, partySize, startsAt: new Date(Date.now() + 60000).toISOString() })
      });
      toast.success(`${walkInTable.label} is now in service`);
      setWalkInTable(null);
      await refreshTables();
    } catch (requestError) {
      const message = requestError.status === 409 ? 'The table changed before the walk-in could be seated.' : requestError.message;
      setError(message);
      toast.error(message);
      await refreshTables();
    } finally {
      setBusyTable('');
    }
  }

  if (claims?.role !== 'staff' || String(claims.restaurantId).toLowerCase() !== restaurantId.toLowerCase()) {
    return <div className="page-shell"><AppHeader /><main className="page-content"><Alert variant="destructive"><AlertTitle>Staff access required</AlertTitle><AlertDescription>This dashboard is limited to staff assigned to this restaurant.</AlertDescription></Alert></main></div>;
  }

  if (loading) return <div className="page-shell"><AppHeader active="staff" /><main className="page-content"><div className="restaurant-skeleton" /></main></div>;

  return <div className="page-shell dashboard-shell">
    <AppHeader active="staff" />
    <main className="page-content dashboard-content">
      <div className="dashboard-title-row">
        <div><p className="eyebrow">SEATSPOT / OPERATIONS</p><h1 className="page-title">Service floor</h1><p className="page-subtitle">A live view of tables, reservations and the waiting line.</p></div>
        <div className="dashboard-controls"><span className={`socket-status ${socketLive ? 'live' : 'reconnecting'}`}><i /> {socketLive ? 'Live sync' : 'Reconnecting'}</span><Button variant="outline" onClick={() => void refreshAll()}><RefreshCw size={15} /> Refresh</Button></div>
      </div>

      {error && <Alert variant="destructive" className="dashboard-error"><CircleAlert size={17} /><div><AlertTitle>Action not completed</AlertTitle><AlertDescription>{error}</AlertDescription></div></Alert>}

      <section className="ops-metrics">
        <Card className="metric-card"><CardContent><span className="metric-label">Available</span><strong className="metric-number metric-green">{counts.available}</strong><span className="metric-foot">Ready to seat</span></CardContent></Card>
        <Card className="metric-card"><CardContent><span className="metric-label">Reserved</span><strong className="metric-number metric-amber">{counts.reserved}</strong><span className="metric-foot">Confirmed booking</span></CardContent></Card>
        <Card className="metric-card"><CardContent><span className="metric-label">Occupied</span><strong className="metric-number metric-slate">{counts.occupied}</strong><span className="metric-foot">Guests in service</span></CardContent></Card>
        <Card className="metric-card"><CardContent><span className="metric-label">Queue</span><strong className="metric-number">{queueLength}</strong><span className="metric-foot">Waiting for a table</span></CardContent></Card>
      </section>

      <div className="dashboard-columns">
        <section className="floor-section">
          <div className="section-heading"><div><h2>Table grid</h2><p>{tables.length} tables Â· changes sync live</p></div><div className="floor-legend"><span className="available"><i /> Available</span><span className="reserved"><i /> Reserved</span><span className="occupied"><i /> Occupied</span></div></div>
          <div className="staff-table-grid">
            {tables.map((table) => {
              const meta = statusMeta[table.status] ?? statusMeta.unavailable;
              return <Card className={`staff-table-card status-${meta.color}`} key={table._id}>
                <CardContent className="staff-table-card-body">
                  <div className="staff-table-head"><span className="staff-table-icon"><Armchair size={17} /></span><Badge variant={table.status === 'available' ? 'success' : table.status === 'reserved' ? 'warning' : 'muted'}>{meta.title}</Badge></div>
                  <div><h3>{table.label}</h3><p><Users size={13} /> Seats {table.capacity}</p></div>
                  <div className="staff-table-actions">
                    {table.status === 'available' && <Button size="sm" onClick={() => { setWalkInTable(table); setPartySize(Math.min(2, table.capacity)); }}>Seat walk-in</Button>}
                    <select aria-label={`Set ${table.label} status`} value={table.status} disabled={busyTable === table._id} onChange={(event) => void updateStatus(table, event.target.value)}>
                      <option value="available">Available</option><option value="reserved" disabled>Reserved</option><option value="occupied">Occupied</option><option value="unavailable">Unavailable</option>
                    </select>
                  </div>
                </CardContent>
              </Card>;
            })}
          </div>
        </section>

        <aside className="staff-queue-section">
          <Card className="staff-queue-card">
            <div className="staff-queue-header"><div><p className="eyebrow">WAITING LIST</p><h2>Queue <span>{queueLength}</span></h2></div><Users size={18} /></div>
            {queue.length ? <ol className="staff-queue-list">{queue.map((userId, index) => <li key={`${userId}-${index}`}><span className="queue-order">{String(index + 1).padStart(2, '0')}</span><div><strong>{displayGuest(userId)}</strong><small>Waiting for a table</small></div><span className="queue-time"><Clock3 size={12} /> In line</span></li>)}</ol> : <div className="queue-empty"><span><Users size={18} /></span><strong>No guests waiting</strong><p>The queue will appear here as guests join.</p></div>}
            <div className="staff-queue-footer"><ArrowDownToLine size={14} /> Queue promotions are delivered privately</div>
          </Card>
        </aside>
      </div>
    </main>

    {walkInTable && <div className="booking-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setWalkInTable(null); }}>
      <section className="booking-dialog" role="dialog" aria-modal="true" aria-labelledby="walkin-title">
        <div className="flex items-start justify-between"><div><p className="eyebrow">WALK-IN / {walkInTable.label}</p><h2 id="walkin-title">Seat a guest.</h2><p>Capacity {walkInTable.capacity} Â· creates a server-side guest identity.</p></div><button className="dialog-close" type="button" aria-label="Close walk-in form" onClick={() => setWalkInTable(null)}>Ã—</button></div>
        <form onSubmit={seatWalkIn} className="booking-form">
          <Field><Label htmlFor="guestName">Guest name</Label><Input id="guestName" value={guestName} onChange={(event) => setGuestName(event.target.value)} maxLength={80} /></Field>
          <Field><Label htmlFor="walkinParty">Party size</Label><Input id="walkinParty" type="number" min="1" max={walkInTable.capacity} value={partySize} onChange={(event) => setPartySize(Math.max(1, Math.min(walkInTable.capacity, Number(event.target.value))))} required /></Field>
          <Button type="submit" size="lg" className="w-full" disabled={busyTable === walkInTable._id}>{busyTable === walkInTable._id ? <LoaderCircle className="animate-spin" size={16} /> : <Check size={16} />} Confirm seating</Button>
        </form>
      </section>
    </div>}
  </div>;
}
