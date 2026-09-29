import { useCallback, useEffect, useMemo, useState } from 'react';
import { io } from 'socket.io-client';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Check, Clock3, Crown, LoaderCircle, MapPin, Minus, Plus, Users, Utensils } from 'lucide-react';
import { toast } from 'sonner';
import { AppHeader } from '../components/app-header.jsx';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert.jsx';
import { Badge } from '../components/ui/badge.jsx';
import { Button } from '../components/ui/button.jsx';
import { Card, CardContent } from '../components/ui/card.jsx';
import { Field, Label } from '../components/ui/field.jsx';
import { Input } from '../components/ui/input.jsx';
import { api } from '../lib/api.js';
import { useAuth } from '../auth/auth-context.jsx';

const statusStyle = {
  available: { label: 'Available', card: 'table-available', variant: 'success' },
  reserved: { label: 'Reserved', card: 'table-reserved', variant: 'warning' },
  occupied: { label: 'Occupied', card: 'table-occupied', variant: 'muted' },
  unavailable: { label: 'Unavailable', card: 'table-unavailable', variant: 'muted' }
};

function errorMessage(error) {
  if (error.status === 409) return 'That table was just taken. Choose another available table.';
  if (error.status === 429) return 'Youâ€™re moving quickly. Wait a moment before trying again.';
  if (error.status === 401) return 'Your session expired. Sign in again to continue.';
  return error.message || 'The request could not be completed.';
}

export function RestaurantDetailPage() {
  const { restaurantId } = useParams();
  const { token, claims } = useAuth();
  const navigate = useNavigate();
  const [restaurant, setRestaurant] = useState(null);
  const [tables, setTables] = useState([]);
  const [queuePosition, setQueuePosition] = useState(0);
  const [queueLength, setQueueLength] = useState(0);
  const [selectedTable, setSelectedTable] = useState(null);
  const [partySize, setPartySize] = useState(2);
  const [bookingTime, setBookingTime] = useState(() => {
    const date = new Date(Date.now() + 60 * 60 * 1000);
    date.setMinutes(Math.ceil(date.getMinutes() / 15) * 15, 0, 0);
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [socketState, setSocketState] = useState('connecting');

  const available = useMemo(() => tables.filter((table) => table.status === 'available').length, [tables]);
  const refreshData = useCallback(async () => {
    const [restaurantResult, tableResult] = await Promise.all([
      api(`/restaurants/${restaurantId}`),
      api(`/restaurants/${restaurantId}/tables`)
    ]);
    setRestaurant(restaurantResult);
    setTables(tableResult.tables ?? []);
    return tableResult.tables ?? [];
  }, [restaurantId]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    Promise.all([
      refreshData(),
      api(`/restaurants/${restaurantId}/queue/position`).catch(() => ({ position: 0 }))
    ]).then(([, position]) => {
      if (active) setQueuePosition(position.position ?? 0);
    }).catch((error) => {
      if (active) setActionError({ title: 'Could not load restaurant', message: errorMessage(error), status: error.status });
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [restaurantId, refreshData]);

  useEffect(() => {
    if (!token) return undefined;
    const socket = io(window.location.origin, { auth: { token }, transports: ['websocket', 'polling'] });
    socket.on('connect', () => {
      setSocketState('live');
      socket.emit('join-room', `availability:${restaurantId}`);
    });
    socket.on('disconnect', () => setSocketState('reconnecting'));
    socket.on('connect_error', (error) => {
      setSocketState('offline');
      if (/invalid|expired/i.test(error.message)) navigate('/auth?reason=expired', { replace: true });
    });
    socket.on('availability:update', (event) => {
      if (event.restaurantId === restaurantId) void refreshData();
    });
    socket.on('queue:position', (event) => {
      if (event.restaurantId === restaurantId) {
        setQueuePosition(event.position);
        setQueueLength(event.queueLength);
      }
    });
    socket.on('queue:promoted', (event) => {
      if (event.restaurantId === restaurantId) {
        setQueuePosition(0);
        setActionError(null);
        toast.success('A table is ready for you', { description: 'You have been promoted from the queue.' });
        void refreshData();
      }
    });
    socket.on('booking:confirmed', (event) => {
      if (event.restaurantId === restaurantId) toast.success('Booking confirmed');
    });
    return () => socket.disconnect();
  }, [token, restaurantId, navigate, refreshData]);

  async function handleBook(event) {
    event.preventDefault();
    if (!selectedTable) return;
    setBusy(true);
    setActionError(null);
    try {
      await api(`/restaurants/${restaurantId}/bookings`, {
        method: 'POST',
        body: JSON.stringify({
          tableId: selectedTable._id,
          partySize,
          startsAt: new Date(bookingTime).toISOString()
        })
      });
      toast.success('Your table is booked');
      setSelectedTable(null);
      await refreshData();
    } catch (error) {
      const message = errorMessage(error);
      setActionError({ title: error.status === 409 ? 'Table unavailable' : error.status === 429 ? 'Rate limit reached' : error.status === 401 ? 'Session expired' : 'Booking failed', message, status: error.status });
      if (error.status === 401) navigate('/auth?reason=expired', { replace: true });
      toast.error(message);
      if (error.status === 409) await refreshData();
    } finally {
      setBusy(false);
    }
  }

  async function joinQueue() {
    setBusy(true);
    setActionError(null);
    try {
      const result = await api(`/restaurants/${restaurantId}/queue`, { method: 'POST', body: JSON.stringify({}) });
      setQueuePosition(result.position ?? 0);
      setQueueLength(result.queueLength ?? 0);
      toast.success(result.alreadyInQueue ? 'Youâ€™re already in the queue' : 'You joined the queue');
    } catch (error) {
      const message = errorMessage(error);
      setActionError({ title: error.status === 429 ? 'Rate limit reached' : 'Could not join queue', message, status: error.status });
      if (error.status === 401) navigate('/auth?reason=expired', { replace: true });
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  async function leaveQueue() {
    setBusy(true);
    try {
      await api(`/restaurants/${restaurantId}/queue`, { method: 'DELETE', body: JSON.stringify({}) });
      setQueuePosition(0);
      toast.success('You left the queue');
    } catch (error) {
      setActionError({ title: 'Could not leave queue', message: errorMessage(error), status: error.status });
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="page-shell"><AppHeader /><main className="page-content"><div className="restaurant-skeleton" /></main></div>;
  if (!restaurant) return <div className="page-shell"><AppHeader /><main className="page-content"><Alert variant="destructive"><AlertTitle>Restaurant unavailable</AlertTitle><AlertDescription>{actionError?.message ?? 'This restaurant could not be found.'}</AlertDescription></Alert></main></div>;

  return <div className="page-shell">
    <AppHeader />
    <main className="page-content detail-content">
      <button className="back-link" type="button" onClick={() => navigate('/restaurants')}><ArrowLeft size={16} /> Restaurants nearby</button>
      <section className="detail-hero">
        <div className="detail-hero-copy">
          <p className="eyebrow">RESTAURANT / LIVE TABLES</p>
          <h1 className="page-title">{restaurant.name}</h1>
          <p className="page-subtitle"><MapPin size={15} /> {restaurant.address || 'Restaurant nearby'}</p>
          <div className="detail-counts">
            <div><strong>{available.toString().padStart(2, '0')}</strong><span>available</span></div>
            <div><strong>{tables.length.toString().padStart(2, '0')}</strong><span>total tables</span></div>
            <span className={`socket-status ${socketState}`}><i /> {socketState === 'live' ? 'Live updates on' : socketState === 'connecting' ? 'Connectingâ€¦' : 'Reconnecting'}</span>
          </div>
        </div>
        <div className="detail-hero-art"><Utensils size={27} /><span>TABLE SERVICE</span><strong>Tonight,<br />sorted.</strong></div>
      </section>

      {actionError && <Alert variant="destructive" className="detail-error"><AlertTitle>{actionError.title}</AlertTitle><AlertDescription>{actionError.message}</AlertDescription></Alert>}

      <div className="detail-columns">
        <section>
          <div className="section-heading"><div><h2>Choose a table</h2><p>Availability updates live</p></div><span className="table-legend"><i className="available-dot" /> Available</span></div>
          <div className="table-grid">
            {tables.map((table, index) => {
              const style = statusStyle[table.status] ?? statusStyle.unavailable;
              const open = table.status === 'available';
              return <Card className={`detail-table ${style.card}`} key={table._id}>
                <CardContent className="detail-table-content">
                  <div className="flex items-start justify-between"><div className="table-number">{String(index + 1).padStart(2, '0')}</div><Badge variant={style.variant}>{style.label}</Badge></div>
                  <h3>{table.label}</h3>
                  <p><Users size={14} /> Up to {table.capacity}</p>
                  <Button size="sm" variant={open ? 'default' : 'outline'} disabled={!open} onClick={() => setSelectedTable(table)}>{open ? 'Book table' : 'Unavailable'} {open && <ArrowRight size={15} />}</Button>
                </CardContent>
              </Card>;
            })}
          </div>
        </section>

        <aside className="queue-panel">
          <Card className="queue-card">
            <CardContent className="queue-card-content">
              <div className="queue-icon"><Crown size={18} /></div>
              <p className="eyebrow">THE VIRTUAL QUEUE</p>
              <h2>Keep your evening open.</h2>
              <p className="queue-copy">Join the line and weâ€™ll let you know when a table is ready.</p>
              <div className="queue-position-box"><span>Your position</span><strong>{queuePosition ? `#${queuePosition}` : 'â€”'}</strong>{queuePosition > 0 && <small>{queueLength || 'In line'} people waiting</small>}</div>
              {queuePosition > 0 ? <Button variant="outline" className="w-full" onClick={leaveQueue} disabled={busy}>Leave queue</Button> : <Button className="w-full" onClick={joinQueue} disabled={busy || available > 0}>{busy ? <LoaderCircle className="animate-spin" size={16} /> : <Plus size={16} />} {available > 0 ? 'Tables are available' : 'Join the queue'}</Button>}
              <p className="queue-foot"><Clock3 size={13} /> Your place updates automatically</p>
            </CardContent>
          </Card>
        </aside>
      </div>
    </main>

    {selectedTable && <div className="booking-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedTable(null); }}>
      <section className="booking-dialog" role="dialog" aria-modal="true" aria-labelledby="booking-title">
        <div className="flex items-start justify-between"><div><p className="eyebrow">TABLE {selectedTable.label}</p><h2 id="booking-title">Make it yours.</h2><p>Seats up to {selectedTable.capacity} guests.</p></div><button className="dialog-close" type="button" aria-label="Close booking form" onClick={() => setSelectedTable(null)}>Ã—</button></div>
        <form onSubmit={handleBook} className="booking-form">
          <Field><Label htmlFor="partySize">Party size</Label><div className="stepper"><Button type="button" variant="outline" size="icon" aria-label="Decrease party size" disabled={partySize <= 1} onClick={() => setPartySize((size) => Math.max(1, size - 1))}><Minus size={15} /></Button><output>{partySize}</output><Button type="button" variant="outline" size="icon" aria-label="Increase party size" disabled={partySize >= selectedTable.capacity} onClick={() => setPartySize((size) => Math.min(selectedTable.capacity, size + 1))}><Plus size={15} /></Button></div></Field>
          <Field><Label htmlFor="bookingTime">Date and time</Label><Input id="bookingTime" type="datetime-local" value={bookingTime} onChange={(event) => setBookingTime(event.target.value)} required /></Field>
          <Button type="submit" size="lg" className="w-full" disabled={busy}>{busy ? 'Confirmingâ€¦' : 'Confirm booking'} <Check size={16} /></Button>
        </form>
      </section>
    </div>}
  </div>;
}
