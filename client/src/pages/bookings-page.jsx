import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarClock, LoaderCircle, MapPin, Users } from 'lucide-react';
import { toast } from 'sonner';
import { AppHeader } from '../components/app-header.jsx';
import { Badge } from '../components/ui/badge.jsx';
import { Button } from '../components/ui/button.jsx';
import { Card, CardContent } from '../components/ui/card.jsx';
import { api } from '../lib/api.js';

export function BookingsPage() {
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [cancellingId, setCancellingId] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await api('/bookings');
      setBookings(result.bookings ?? []);
    } catch (requestError) {
      setError(requestError.message || 'Could not load your bookings.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function cancelBooking(booking) {
    setCancellingId(booking._id);
    try {
      await api(`/bookings/${booking._id}/cancel`, { method: 'PATCH' });
      toast.success('Booking cancelled', { description: booking.restaurantName ?? undefined });
      setBookings((current) => current.filter((entry) => entry._id !== booking._id));
    } catch (cancelError) {
      toast.error(cancelError.message || 'Could not cancel this booking');
      if (cancelError.status === 409) void load();
    } finally {
      setCancellingId('');
    }
  }

  return <div className="page-shell">
    <AppHeader active="bookings" />
    <main className="page-content">
      <p className="eyebrow">SEATSPOT / BOOKINGS</p>
      <h1 className="page-title">Your bookings.</h1>
      <p className="page-subtitle">Upcoming confirmed tables you can still cancel.</p>

      {error && <div role="alert" className="inline-error">{error}</div>}
      {loading ? <div className="restaurant-skeleton" /> : bookings.length === 0 ? <div className="empty-results">
        <h3>No active bookings</h3>
        <p>Book a table from the nearby list and it will show up here.</p>
        <Link to="/restaurants"><Button>Find a table</Button></Link>
      </div> : <div className="restaurant-grid">
        {bookings.map((booking) => <Card key={booking._id} className="restaurant-card"><CardContent className="restaurant-card-content">
          <div className="restaurant-card-top"><div><h3>{booking.restaurantName ?? 'Restaurant'}</h3><p><MapPin size={13} /> {booking.restaurantAddress ?? ''}</p></div><Badge variant="outline"><CalendarClock size={13} /> {new Date(booking.startsAt).toLocaleString()}</Badge></div>
          <p className="cuisine-tag"><Users size={13} /> Party of {booking.partySize}</p>
          <Button variant="outline" disabled={cancellingId === booking._id} onClick={() => cancelBooking(booking)}>
            {cancellingId === booking._id ? <LoaderCircle className="animate-spin" size={15} /> : null} Cancel booking
          </Button>
        </CardContent></Card>)}
      </div>}
    </main>
  </div>;
}
