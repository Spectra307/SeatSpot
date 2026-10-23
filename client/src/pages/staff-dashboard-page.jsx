import { useCallback, useEffect, useMemo, useState } from 'react';
import { io } from 'socket.io-client';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Armchair,
  ArrowDownToLine,
  BarChart3,
  Calendar,
  Check,
  CheckCircle2,
  CircleAlert,
  Clock,
  Clock3,
  Filter,
  Layers,
  LoaderCircle,
  RefreshCw,
  Search,
  Timer,
  UserCheck,
  UserX,
  Users,
  XCircle
} from 'lucide-react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  AreaChart,
  Area
} from 'recharts';
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

const bookingBadgeVariants = {
  confirmed: 'warning',
  seated: 'default',
  completed: 'success',
  cancelled: 'destructive',
  'no-show': 'muted'
};

function displayGuest(userId) {
  return `Guest · ${String(userId).slice(-6)}`;
}

export function StaffDashboardPage() {
  const { restaurantId } = useParams();
  const { token, claims } = useAuth();
  const navigate = useNavigate();

  // Active view tab: 'floor' | 'bookings' | 'analytics'
  const [activeTab, setActiveTab] = useState('floor');

  // Floor & Queue state
  const [tables, setTables] = useState([]);
  const [queue, setQueue] = useState([]);
  const [queueLength, setQueueLength] = useState(0);

  // Overview metrics state
  const [overview, setOverview] = useState({
    bookingsToday: 0,
    cancellationsToday: 0,
    noShowsToday: 0
  });

  // Bookings panel state
  const [bookings, setBookings] = useState([]);
  const [bookingsTotal, setBookingsTotal] = useState(0);
  const [bookingsPage, setBookingsPage] = useState(1);
  const [bookingsTotalPages, setBookingsTotalPages] = useState(1);
  const [filterDate, setFilterDate] = useState('');
  const [filterStatus, setFilterStatus] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [bookingsLoading, setBookingsLoading] = useState(false);
  const [busyBookingId, setBusyBookingId] = useState('');

  // Analytics state
  const [statsRange, setStatsRange] = useState('7d');
  const [statsData, setStatsData] = useState(null);
  const [statsLoading, setStatsLoading] = useState(false);

  // Walk-in modal & general state
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

  // Fetch functions
  const refreshTables = useCallback(async () => {
    const result = await api(`/restaurants/${restaurantId}/dashboard/tables`);
    setTables(result.tables ?? []);
  }, [restaurantId]);

  const refreshQueue = useCallback(async () => {
    const result = await api(`/restaurants/${restaurantId}/dashboard/queue`);
    setQueue(result.queue ?? []);
    setQueueLength(result.queueLength ?? 0);
  }, [restaurantId]);

  const refreshOverview = useCallback(async () => {
    try {
      const data = await api(`/restaurants/${restaurantId}/dashboard/overview`);
      setOverview({
        bookingsToday: data.bookingsToday ?? 0,
        cancellationsToday: data.cancellationsToday ?? 0,
        noShowsToday: data.noShowsToday ?? 0
      });
    } catch {
      // Best-effort
    }
  }, [restaurantId]);

  const fetchBookings = useCallback(async (page = 1) => {
    setBookingsLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('page', String(page));
      params.set('limit', '10');
      if (filterStatus && filterStatus !== 'all') params.set('status', filterStatus);
      if (filterDate) params.set('date', filterDate);
      if (searchQuery.trim()) params.set('q', searchQuery.trim());

      const res = await api(`/restaurants/${restaurantId}/dashboard/bookings?${params.toString()}`);
      setBookings(res.bookings ?? []);
      setBookingsTotal(res.total ?? 0);
      setBookingsPage(res.page ?? 1);
      setBookingsTotalPages(res.totalPages ?? 1);
    } catch (err) {
      toast.error('Could not load bookings', { description: err.message });
    } finally {
      setBookingsLoading(false);
    }
  }, [restaurantId, filterStatus, filterDate, searchQuery]);

  const fetchStats = useCallback(async () => {
    setStatsLoading(true);
    try {
      const data = await api(`/restaurants/${restaurantId}/dashboard/stats?range=${statsRange}`);
      setStatsData(data);
    } catch (err) {
      toast.error('Could not load analytics', { description: err.message });
    } finally {
      setStatsLoading(false);
    }
  }, [restaurantId, statsRange]);

  const refreshAll = useCallback(async () => {
    await Promise.all([refreshTables(), refreshQueue(), refreshOverview()]);
  }, [refreshQueue, refreshTables, refreshOverview]);

  // Initial load
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

  // Load bookings or stats when respective tabs become active
  useEffect(() => {
    if (activeTab === 'bookings') {
      void fetchBookings(1);
    } else if (activeTab === 'analytics') {
      void fetchStats();
    }
  }, [activeTab, fetchBookings, fetchStats]);

  // Socket.IO real-time connection
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
      if (event.restaurantId === restaurantId) {
        void refreshTables();
        void refreshOverview();
      }
    });
    socket.on('queue:update', (event) => {
      if (event.restaurantId === restaurantId) {
        setQueue(event.payload?.queue ?? []);
        setQueueLength(event.payload?.queueLength ?? event.payload?.queue?.length ?? 0);
      }
    });
    socket.on('booking:update', (event) => {
      if (event.restaurantId === restaurantId) {
        if (event.type === 'created') {
          toast.info('New booking received', {
            description: `${event.booking?.customerName || 'A customer'} reserved a table.`
          });
        } else if (event.type === 'cancelled') {
          toast.warning('A booking was cancelled');
        } else if (event.type === 'status_changed') {
          toast.info(`Booking updated to ${event.booking?.status}`);
        }
        void refreshAll();
        void fetchBookings(bookingsPage);
        void fetchStats();
      }
    });
    return () => socket.disconnect();
  }, [claims?.role, claims?.restaurantId, restaurantId, token, navigate, refreshTables, refreshOverview, refreshAll, fetchBookings, fetchStats, bookingsPage]);

  // Status transitions
  async function updateTableStatus(table, status) {
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

  async function updateBookingStatus(bookingId, status) {
    setBusyBookingId(bookingId);
    try {
      await api(`/restaurants/${restaurantId}/dashboard/bookings/${bookingId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status })
      });
      toast.success(`Booking marked as ${status}`);
      await Promise.all([fetchBookings(bookingsPage), refreshAll()]);
    } catch (err) {
      toast.error(`Could not change status to ${status}`, { description: err.message });
    } finally {
      setBusyBookingId('');
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
      await refreshOverview();
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
    return (
      <div className="page-shell">
        <AppHeader />
        <main className="page-content">
          <Alert variant="destructive">
            <AlertTitle>Staff access required</AlertTitle>
            <AlertDescription>This dashboard is limited to staff assigned to this restaurant.</AlertDescription>
          </Alert>
        </main>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="page-shell">
        <AppHeader active="staff" />
        <main className="page-content">
          <div className="restaurant-skeleton" />
        </main>
      </div>
    );
  }

  return (
    <div className="page-shell dashboard-shell">
      <AppHeader active="staff" />
      <main className="page-content dashboard-content">
        <div className="dashboard-title-row">
          <div>
            <p className="eyebrow">SEATSPOT / OPERATIONS</p>
            <h1 className="page-title">Restaurant Floor & Operations</h1>
            <p className="page-subtitle">A live view of tables, reservations, and service tracking.</p>
          </div>
          <div className="dashboard-controls">
            <span className={`socket-status ${socketLive ? 'live' : 'reconnecting'}`}>
              <i /> {socketLive ? 'Live sync' : 'Reconnecting'}
            </span>
            <Button variant="outline" onClick={() => void refreshAll()}>
              <RefreshCw size={15} /> Refresh
            </Button>
          </div>
        </div>

        {error && (
          <Alert variant="destructive" className="dashboard-error">
            <CircleAlert size={17} />
            <div>
              <AlertTitle>Action not completed</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </div>
          </Alert>
        )}

        {/* 1. Overview cards: tables free / reserved / occupied, bookings today, queue, cancellations, no-shows */}
        <section className="ops-metrics-grid">
          <Card className="metric-card">
            <CardContent>
              <span className="metric-label">Free Tables</span>
              <strong className="metric-number metric-green">{counts.available}</strong>
              <span className="metric-foot">Ready to seat</span>
            </CardContent>
          </Card>
          <Card className="metric-card">
            <CardContent>
              <span className="metric-label">Reserved</span>
              <strong className="metric-number metric-amber">{counts.reserved}</strong>
              <span className="metric-foot">Awaiting arrival</span>
            </CardContent>
          </Card>
          <Card className="metric-card">
            <CardContent>
              <span className="metric-label">Occupied</span>
              <strong className="metric-number metric-slate">{counts.occupied}</strong>
              <span className="metric-foot">Guests in service</span>
            </CardContent>
          </Card>
          <Card className="metric-card">
            <CardContent>
              <span className="metric-label">In Queue</span>
              <strong className="metric-number">{queueLength}</strong>
              <span className="metric-foot">Waiting in line</span>
            </CardContent>
          </Card>
          <Card className="metric-card">
            <CardContent>
              <span className="metric-label">Bookings Today</span>
              <strong className="metric-number metric-teal">{overview.bookingsToday}</strong>
              <span className="metric-foot">Total reserved today</span>
            </CardContent>
          </Card>
          <Card className="metric-card">
            <CardContent>
              <span className="metric-label">Cancellations</span>
              <strong className="metric-number metric-rose">{overview.cancellationsToday}</strong>
              <span className="metric-foot">Cancelled today</span>
            </CardContent>
          </Card>
          <Card className="metric-card">
            <CardContent>
              <span className="metric-label">No-Shows</span>
              <strong className="metric-number metric-muted">{overview.noShowsToday}</strong>
              <span className="metric-foot">Did not arrive today</span>
            </CardContent>
          </Card>
        </section>

        {/* Navigation Tabs */}
        <nav className="dashboard-tab-bar" aria-label="Dashboard navigation">
          <button
            type="button"
            className={`dashboard-tab-btn ${activeTab === 'floor' ? 'active' : ''}`}
            onClick={() => setActiveTab('floor')}
          >
            <Armchair size={16} /> Table Floor & Queue
          </button>
          <button
            type="button"
            className={`dashboard-tab-btn ${activeTab === 'bookings' ? 'active' : ''}`}
            onClick={() => setActiveTab('bookings')}
          >
            <Calendar size={16} /> Bookings Manager
          </button>
          <button
            type="button"
            className={`dashboard-tab-btn ${activeTab === 'analytics' ? 'active' : ''}`}
            onClick={() => setActiveTab('analytics')}
          >
            <BarChart3 size={16} /> Tracking & Analytics
          </button>
        </nav>

        {/* TAB 1: Live Floor & Queue */}
        {activeTab === 'floor' && (
          <div className="dashboard-columns">
            <section className="floor-section">
              <div className="section-heading">
                <div>
                  <h2>Table grid</h2>
                  <p>{tables.length} tables · changes sync live</p>
                </div>
                <div className="floor-legend">
                  <span className="available"><i /> Available</span>
                  <span className="reserved"><i /> Reserved</span>
                  <span className="occupied"><i /> Occupied</span>
                </div>
              </div>
              <div className="staff-table-grid">
                {tables.map((table) => {
                  const meta = statusMeta[table.status] ?? statusMeta.unavailable;
                  return (
                    <Card className={`staff-table-card status-${meta.color}`} key={table._id}>
                      <CardContent className="staff-table-card-body">
                        <div className="staff-table-head">
                          <span className="staff-table-icon"><Armchair size={17} /></span>
                          <Badge variant={table.status === 'available' ? 'success' : table.status === 'reserved' ? 'warning' : 'muted'}>
                            {meta.title}
                          </Badge>
                        </div>
                        <div>
                          <h3>{table.label}</h3>
                          <p><Users size={13} /> Seats {table.capacity}</p>
                        </div>
                        <div className="staff-table-actions">
                          {table.status === 'available' && (
                            <Button size="sm" onClick={() => { setWalkInTable(table); setPartySize(Math.min(2, table.capacity)); }}>
                              Seat walk-in
                            </Button>
                          )}
                          <select
                            aria-label={`Set ${table.label} status`}
                            value={table.status}
                            disabled={busyTable === table._id}
                            onChange={(event) => void updateTableStatus(table, event.target.value)}
                          >
                            <option value="available">Available</option>
                            <option value="reserved" disabled>Reserved</option>
                            <option value="occupied">Occupied</option>
                            <option value="unavailable">Unavailable</option>
                          </select>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            </section>

            <aside className="staff-queue-section">
              <Card className="staff-queue-card">
                <div className="staff-queue-header">
                  <div>
                    <p className="eyebrow">WAITING LIST</p>
                    <h2>Queue <span>{queueLength}</span></h2>
                  </div>
                  <Users size={18} />
                </div>
                {queue.length ? (
                  <ol className="staff-queue-list">
                    {queue.map((userId, index) => (
                      <li key={`${userId}-${index}`}>
                        <span className="queue-order">{String(index + 1).padStart(2, '0')}</span>
                        <div>
                          <strong>{displayGuest(userId)}</strong>
                          <small>Waiting for a table</small>
                        </div>
                        <span className="queue-time"><Clock3 size={12} /> In line</span>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <div className="queue-empty">
                    <span><Users size={18} /></span>
                    <strong>No guests waiting</strong>
                    <p>The queue will appear here as guests join.</p>
                  </div>
                )}
                <div className="staff-queue-footer">
                  <ArrowDownToLine size={14} /> Queue promotions are delivered privately
                </div>
              </Card>
            </aside>
          </div>
        )}

        {/* TAB 2: Bookings Panel */}
        {activeTab === 'bookings' && (
          <section className="bookings-panel-container">
            <div className="bookings-filters-bar">
              <div className="search-box">
                <Search size={15} />
                <Input
                  placeholder="Search customer name…"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void fetchBookings(1); }}
                />
              </div>

              <div className="filter-item">
                <Calendar size={15} />
                <Input
                  type="date"
                  value={filterDate}
                  onChange={(e) => setFilterDate(e.target.value)}
                  aria-label="Filter by date"
                />
                {filterDate && (
                  <Button variant="ghost" size="sm" onClick={() => setFilterDate('')}>
                    Clear
                  </Button>
                )}
              </div>

              <div className="filter-item">
                <Filter size={15} />
                <select
                  value={filterStatus}
                  onChange={(e) => setFilterStatus(e.target.value)}
                  aria-label="Filter by status"
                  className="filter-select"
                >
                  <option value="all">All Statuses</option>
                  <option value="confirmed">Confirmed</option>
                  <option value="seated">Seated</option>
                  <option value="completed">Completed</option>
                  <option value="cancelled">Cancelled</option>
                  <option value="no-show">No-Show</option>
                </select>
              </div>

              <Button onClick={() => void fetchBookings(1)} size="sm">
                Apply Filters
              </Button>
            </div>

            <div className="bookings-table-wrapper">
              {bookingsLoading ? (
                <div className="p-8 text-center text-muted-foreground flex items-center justify-center gap-2">
                  <LoaderCircle className="animate-spin" size={18} /> Loading bookings…
                </div>
              ) : bookings.length === 0 ? (
                <div className="empty-results">
                  <span><Calendar size={20} /></span>
                  <h3>No bookings found</h3>
                  <p>Try adjusting your search query, status, or date filter.</p>
                </div>
              ) : (
                <table className="bookings-data-table">
                  <thead>
                    <tr>
                      <th>Customer Name</th>
                      <th>Party Size</th>
                      <th>Table</th>
                      <th>Booking Time</th>
                      <th>Status</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bookings.map((booking) => {
                      const starts = new Date(booking.startsAt).toLocaleString('en-IN', {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit'
                      });
                      const isBusy = busyBookingId === booking._id;

                      return (
                        <tr key={booking._id} className={`booking-row-${booking.status}`}>
                          <td>
                            <strong>{booking.customerName}</strong>
                            {booking.source === 'walk-in' && <span className="source-tag">Walk-in</span>}
                            {booking.source === 'queue' && <span className="source-tag">Queue</span>}
                          </td>
                          <td>
                            <span className="party-chip">
                              <Users size={13} /> {booking.partySize}
                            </span>
                          </td>
                          <td>
                            <span className="table-badge">{booking.tableLabel}</span>
                          </td>
                          <td>
                            <div className="flex items-center gap-1.5 text-xs text-foreground/85">
                              <Clock size={13} /> {starts}
                            </div>
                          </td>
                          <td>
                            <Badge variant={bookingBadgeVariants[booking.status] ?? 'muted'}>
                              {booking.status}
                            </Badge>
                          </td>
                          <td className="row-actions-cell">
                            {isBusy ? (
                              <LoaderCircle className="animate-spin text-muted-foreground" size={16} />
                            ) : (
                              <>
                                {booking.status === 'confirmed' && (
                                  <>
                                    <button
                                      type="button"
                                      className="action-pill action-seat"
                                      onClick={() => void updateBookingStatus(booking._id, 'seated')}
                                      title="Seat customer"
                                    >
                                      <UserCheck size={13} /> Seat
                                    </button>
                                    <button
                                      type="button"
                                      className="action-pill action-noshow"
                                      onClick={() => void updateBookingStatus(booking._id, 'no-show')}
                                      title="Mark as no-show"
                                    >
                                      <UserX size={13} /> No-Show
                                    </button>
                                    <button
                                      type="button"
                                      className="action-pill action-cancel"
                                      onClick={() => void updateBookingStatus(booking._id, 'cancelled')}
                                      title="Cancel reservation"
                                    >
                                      <XCircle size={13} />
                                    </button>
                                  </>
                                )}
                                {booking.status === 'seated' && (
                                  <>
                                    <button
                                      type="button"
                                      className="action-pill action-complete"
                                      onClick={() => void updateBookingStatus(booking._id, 'completed')}
                                      title="Mark finished / complete"
                                    >
                                      <CheckCircle2 size={13} /> Complete
                                    </button>
                                    <button
                                      type="button"
                                      className="action-pill action-cancel"
                                      onClick={() => void updateBookingStatus(booking._id, 'cancelled')}
                                      title="Cancel"
                                    >
                                      <XCircle size={13} />
                                    </button>
                                  </>
                                )}
                                {['completed', 'cancelled', 'no-show'].includes(booking.status) && (
                                  <span className="text-xs text-muted-foreground italic">Closed</span>
                                )}
                              </>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>

            {/* Pagination */}
            <div className="bookings-pagination">
              <span className="text-xs text-muted-foreground">
                Showing {bookings.length} of {bookingsTotal} booking{bookingsTotal !== 1 ? 's' : ''}
              </span>
              <div className="pagination-buttons">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={bookingsPage <= 1 || bookingsLoading}
                  onClick={() => void fetchBookings(bookingsPage - 1)}
                >
                  Previous
                </Button>
                <span className="page-indicator">
                  Page {bookingsPage} of {bookingsTotalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={bookingsPage >= bookingsTotalPages || bookingsLoading}
                  onClick={() => void fetchBookings(bookingsPage + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          </section>
        )}

        {/* TAB 3: Tracking & Analytics (Recharts) */}
        {activeTab === 'analytics' && (
          <section className="analytics-container">
            <div className="analytics-header-row">
              <div>
                <h2>Performance & Floor Metrics</h2>
                <p>Data aggregation computed from completed service and booking logs.</p>
              </div>
              <div className="range-selector">
                <Button
                  variant={statsRange === '7d' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setStatsRange('7d')}
                >
                  Last 7 Days
                </Button>
                <Button
                  variant={statsRange === '30d' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setStatsRange('30d')}
                >
                  Last 30 Days
                </Button>
              </div>
            </div>

            {statsLoading || !statsData ? (
              <div className="p-12 text-center text-muted-foreground flex items-center justify-center gap-2">
                <LoaderCircle className="animate-spin" size={18} /> Calculating statistics…
              </div>
            ) : (
              <>
                {/* Analytics KPI Summary Cards */}
                <div className="analytics-kpi-grid">
                  <Card className="metric-card">
                    <CardContent>
                      <span className="metric-label flex items-center gap-1.5">
                        <Timer size={14} /> Avg Turnover Time
                      </span>
                      <strong className="metric-number metric-teal">
                        {statsData.avgTurnoverMinutes} min
                      </strong>
                      <span className="metric-foot">Seated → Completed</span>
                    </CardContent>
                  </Card>
                  <Card className="metric-card">
                    <CardContent>
                      <span className="metric-label flex items-center gap-1.5">
                        <Calendar size={14} /> Total Volume
                      </span>
                      <strong className="metric-number">
                        {statsData.totalBookings}
                      </strong>
                      <span className="metric-foot">Bookings in {statsRange}</span>
                    </CardContent>
                  </Card>
                  <Card className="metric-card">
                    <CardContent>
                      <span className="metric-label flex items-center gap-1.5">
                        <XCircle size={14} /> Cancellation Rate
                      </span>
                      <strong className="metric-number metric-rose">
                        {statsData.cancellationRate}%
                      </strong>
                      <span className="metric-foot">{statsData.cancellations} cancelled</span>
                    </CardContent>
                  </Card>
                  <Card className="metric-card">
                    <CardContent>
                      <span className="metric-label flex items-center gap-1.5">
                        <UserX size={14} /> No-Show Rate
                      </span>
                      <strong className="metric-number metric-amber">
                        {statsData.noShowRate}%
                      </strong>
                      <span className="metric-foot">{statsData.noShows} no-shows</span>
                    </CardContent>
                  </Card>
                </div>

                {/* Charts Grid */}
                <div className="analytics-charts-grid">
                  <Card className="chart-card">
                    <CardContent className="p-5">
                      <div className="chart-head mb-4">
                        <h3 className="font-bold text-base">Bookings per Day</h3>
                        <p className="text-xs text-muted-foreground">Daily booking volume over the last {statsRange === '30d' ? '30' : '7'} days</p>
                      </div>
                      <div className="chart-wrapper" style={{ width: '100%', height: 260 }}>
                        <ResponsiveContainer width="100%" height="100%">
                          <AreaChart data={statsData.bookingsPerDay} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                            <defs>
                              <linearGradient id="colorBookings" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor="#087f70" stopOpacity={0.4} />
                                <stop offset="95%" stopColor="#087f70" stopOpacity={0.0} />
                              </linearGradient>
                            </defs>
                            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5ece8" />
                            <XAxis
                              dataKey="date"
                              tick={{ fontSize: 11, fill: '#71807a' }}
                              tickFormatter={(str) => str.slice(5)}
                            />
                            <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#71807a' }} />
                            <Tooltip
                              contentStyle={{ background: '#153d35', borderRadius: 8, color: '#fff', border: 'none', fontSize: 12 }}
                              labelFormatter={(label) => `Date: ${label}`}
                            />
                            <Area
                              type="monotone"
                              dataKey="count"
                              name="Bookings"
                              stroke="#087f70"
                              strokeWidth={2.5}
                              fillOpacity={1}
                              fill="url(#colorBookings)"
                            />
                          </AreaChart>
                        </ResponsiveContainer>
                      </div>
                    </CardContent>
                  </Card>

                  <Card className="chart-card">
                    <CardContent className="p-5">
                      <div className="chart-head mb-4">
                        <h3 className="font-bold text-base">Peak Hours Distribution</h3>
                        <p className="text-xs text-muted-foreground">Distribution of reservation start times by hour of day</p>
                      </div>
                      <div className="chart-wrapper" style={{ width: '100%', height: 260 }}>
                        <ResponsiveContainer width="100%" height="100%">
                          <BarChart data={statsData.peakHours} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5ece8" />
                            <XAxis
                              dataKey="label"
                              tick={{ fontSize: 10, fill: '#71807a' }}
                              interval={2}
                            />
                            <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#71807a' }} />
                            <Tooltip
                              contentStyle={{ background: '#153d35', borderRadius: 8, color: '#fff', border: 'none', fontSize: 12 }}
                            />
                            <Bar
                              dataKey="count"
                              name="Reservations"
                              fill="#153d35"
                              radius={[4, 4, 0, 0]}
                            />
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    </CardContent>
                  </Card>
                </div>
              </>
            )}
          </section>
        )}
      </main>

      {/* Walk-in Form Modal */}
      {walkInTable && (
        <div className="booking-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setWalkInTable(null); }}>
          <section className="booking-dialog" role="dialog" aria-modal="true" aria-labelledby="walkin-title">
            <div className="flex items-start justify-between">
              <div>
                <p className="eyebrow">WALK-IN / {walkInTable.label}</p>
                <h2 id="walkin-title">Seat a guest.</h2>
                <p>Capacity {walkInTable.capacity} · creates a server-side guest identity.</p>
              </div>
              <button className="dialog-close" type="button" aria-label="Close walk-in form" onClick={() => setWalkInTable(null)}>
                ×
              </button>
            </div>
            <form onSubmit={seatWalkIn} className="booking-form">
              <Field>
                <Label htmlFor="guestName">Guest name</Label>
                <Input id="guestName" value={guestName} onChange={(event) => setGuestName(event.target.value)} maxLength={80} />
              </Field>
              <Field>
                <Label htmlFor="walkinParty">Party size</Label>
                <Input
                  id="walkinParty"
                  type="number"
                  min="1"
                  max={walkInTable.capacity}
                  value={partySize}
                  onChange={(event) => setPartySize(Math.max(1, Math.min(walkInTable.capacity, Number(event.target.value))))}
                  required
                />
              </Field>
              <Button type="submit" size="lg" className="w-full" disabled={busyTable === walkInTable._id}>
                {busyTable === walkInTable._id ? <LoaderCircle className="animate-spin" size={16} /> : <Check size={16} />} Confirm seating
              </Button>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}
