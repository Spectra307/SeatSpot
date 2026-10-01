import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, LocateFixed, MapPin, Radio, Search, Store, Utensils } from 'lucide-react';
import { io } from 'socket.io-client';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { AppHeader } from '../components/app-header.jsx';
import { Badge } from '../components/ui/badge.jsx';
import { Button } from '../components/ui/button.jsx';
import { Card, CardContent } from '../components/ui/card.jsx';
import { Field, Label } from '../components/ui/field.jsx';
import { Input } from '../components/ui/input.jsx';
import { api } from '../lib/api.js';
import { useAuth } from '../auth/auth-context.jsx';

const DEFAULT_LOCATION = { latitude: 12.9255, longitude: 80.2201 };
const INITIAL_CRITERIA = { radiusMeters: 12000, sort: 'distance', openOnly: false };
const RADII = [
  { value: 2000, label: '2 km' },
  { value: 5000, label: '5 km' },
  { value: 12000, label: '12 km' },
  { value: 25000, label: '25 km' }
];
const SORT_OPTIONS = [
  { value: 'distance', label: 'Closest first' },
  { value: 'availability', label: 'Most tables open' }
];
const MAX_RESULTS = 24;
const restaurantPhotos = [
  'photo-1414235077428-338989a2e8c0',
  'photo-1517248135467-4c7edcad34c4',
  'photo-1514933651103-005eec06c04b',
  'photo-1559339352-11d035aa65de'
];
const photoFor = (index) => `https://images.unsplash.com/${restaurantPhotos[index % restaurantPhotos.length]}?auto=format&fit=crop&w=900&q=82`;

function formatDistance(meters) {
  if (!Number.isFinite(meters)) return 'Nearby';
  return meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(1)} km`;
}

function Availability({ counts, listed }) {
  if (listed) return <Badge variant="outline" className="gap-1.5 px-2.5 py-1"><Store size={13} /> Google listing</Badge>;
  const available = counts?.available ?? 0;
  const total = counts?.total ?? 0;
  return <Badge variant={available > 0 ? 'success' : 'muted'} className="gap-1.5 px-2.5 py-1">
    <span className={`size-1.5 rounded-full ${available ? 'bg-emerald-600' : 'bg-slate-400'}`} />
    {available} of {total} tables open
  </Badge>;
}

export function RestaurantListPage() {
  const { token } = useAuth();
  const [latitude, setLatitude] = useState(String(DEFAULT_LOCATION.latitude));
  const [longitude, setLongitude] = useState(String(DEFAULT_LOCATION.longitude));
  const [criteria, setCriteria] = useState(INITIAL_CRITERIA);
  const [origin, setOrigin] = useState(DEFAULT_LOCATION);
  const [restaurants, setRestaurants] = useState([]);
  const [loading, setLoading] = useState(true);
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState('');
  const [locationLabel, setLocationLabel] = useState('Chennai, India');
  const [socketState, setSocketState] = useState('connecting');
  const [updatedId, setUpdatedId] = useState('');
  const socketRef = useRef(null);
  const requestRef = useRef(0);
  const flashRef = useRef(null);
  const navigate = useNavigate();

  const flashRestaurant = useCallback((restaurantId) => {
    setUpdatedId(restaurantId);
    clearTimeout(flashRef.current);
    flashRef.current = setTimeout(() => setUpdatedId(''), 1400);
  }, []);

  const searchNearby = useCallback(async (point, nextCriteria) => {
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({
        latitude: String(point.latitude),
        longitude: String(point.longitude),
        radiusMeters: String(nextCriteria.radiusMeters),
        sort: nextCriteria.sort,
        openOnly: nextCriteria.openOnly ? 'true' : 'false',
        limit: String(MAX_RESULTS)
      });
      const result = await api(`/restaurants/nearby?${params}`);
      if (requestRef.current !== requestId) return;
      setRestaurants(result.restaurants ?? []);
      setOrigin(point);
      setCriteria(nextCriteria);
    } catch (requestError) {
      if (requestRef.current !== requestId) return;
      setError(requestError.message || 'Restaurant search is unavailable.');
      if (requestError.status !== 401) toast.error('Search could not be completed', { description: requestError.message });
    } finally {
      if (requestRef.current === requestId) setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const search = (point) => {
      if (!cancelled) void searchNearby(point, INITIAL_CRITERIA);
    };
    if (!navigator.geolocation) {
      search(DEFAULT_LOCATION);
      return () => { cancelled = true; };
    }
    navigator.geolocation.getCurrentPosition((position) => {
      const point = { latitude: position.coords.latitude, longitude: position.coords.longitude };
      if (cancelled) return;
      setLatitude(point.latitude.toFixed(4));
      setLongitude(point.longitude.toFixed(4));
      setLocationLabel('Your current location');
      search(point);
    }, () => search(DEFAULT_LOCATION), { enableHighAccuracy: false, timeout: 7000, maximumAge: 120000 });
    return () => { cancelled = true; };
  }, [searchNearby]);

  useEffect(() => {
    if (!token) return undefined;
    const socket = io(window.location.origin, { auth: { token }, transports: ['websocket', 'polling'] });
    socketRef.current = socket;
    socket.on('connect', () => setSocketState('live'));
    socket.on('disconnect', () => setSocketState('reconnecting'));
    socket.on('connect_error', (connectError) => {
      setSocketState('offline');
      if (/invalid|expired/i.test(connectError.message)) navigate('/auth?reason=expired', { replace: true });
    });
    socket.on('availability:update', (event) => {
      setRestaurants((current) => current.map((restaurant) => (
        restaurant.restaurantId === event.restaurantId
          ? { ...restaurant, availability: { ...restaurant.availability, ...event.payload } }
          : restaurant
      )));
      flashRestaurant(String(event.restaurantId));
    });
    return () => {
      socketRef.current = null;
      clearTimeout(flashRef.current);
      socket.disconnect();
    };
  }, [token, navigate, flashRestaurant]);

  useEffect(() => {
    const socket = socketRef.current;
    if (!socket?.connected) return;
    for (const restaurant of restaurants) {
      if (restaurant.restaurantId) socket.emit('join-room', `availability:${restaurant.restaurantId}`);
    }
  }, [restaurants, socketState]);

  const openCount = useMemo(() => restaurants.filter((restaurant) => (restaurant.availability?.available ?? 0) > 0).length, [restaurants]);
  const hasTableCounts = useMemo(() => restaurants.some((restaurant) => (restaurant.availability?.total ?? 0) > 0), [restaurants]);
  const radiusLabel = RADII.find((option) => option.value === criteria.radiusMeters)?.label ?? `${criteria.radiusMeters / 1000} km`;
  const resultsSummary = loading
    ? 'Checking live availability…'
    : `${restaurants.length} ${restaurants.length === 1 ? 'place' : 'places'} within ${radiusLabel}${hasTableCounts ? ` · ${openCount} with open tables` : ''}`;
  const filtersActive = criteria.openOnly || criteria.sort !== INITIAL_CRITERIA.sort;

  function useCurrentLocation() {
    if (!navigator.geolocation) {
      toast.error('Geolocation is not available in this browser');
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition((position) => {
      const point = { latitude: position.coords.latitude, longitude: position.coords.longitude };
      setLatitude(point.latitude.toFixed(4));
      setLongitude(point.longitude.toFixed(4));
      setLocationLabel('Your current location');
      setLocating(false);
      void searchNearby(point, criteria);
    }, () => {
      setLocating(false);
      toast.error('Could not get your location', { description: 'Enter coordinates manually to search nearby.' });
    }, { enableHighAccuracy: false, timeout: 10000 });
  }

  function handleManualSearch(event) {
    event.preventDefault();
    const point = { latitude: Number(latitude), longitude: Number(longitude) };
    if (!Number.isFinite(point.latitude) || !Number.isFinite(point.longitude) || Math.abs(point.latitude) > 90 || Math.abs(point.longitude) > 180) {
      toast.error('Enter valid coordinates', { description: 'Latitude must be within \u00b190 and longitude within \u00b1180.' });
      return;
    }
    setLocationLabel('Selected coordinates');
    void searchNearby(point, criteria);
  }

  function applyCriteria(patch) {
    void searchNearby(origin, { ...criteria, ...patch });
  }

  return <div className="page-shell">
    <AppHeader />
    <main className="page-content">
      <div className="directory-heading">
        <div>
          <p className="eyebrow">SEATSPOT / DISCOVER</p>
          <h1 className="page-title">Find your table.</h1>
          <p className="page-subtitle">A good meal starts with a place that has room for you.</p>
        </div>
        <div className="location-chip"><MapPin size={16} /><div><span>Searching near</span><strong>{locationLabel}</strong></div></div>
      </div>

      <Card className="search-panel"><CardContent className="search-panel-content">
        <form onSubmit={handleManualSearch} className="coordinate-form">
          <Field><Label htmlFor="latitude">Latitude</Label><Input id="latitude" inputMode="decimal" value={latitude} onChange={(event) => setLatitude(event.target.value)} /></Field>
          <Field><Label htmlFor="longitude">Longitude</Label><Input id="longitude" inputMode="decimal" value={longitude} onChange={(event) => setLongitude(event.target.value)} /></Field>
          <Button type="submit" disabled={loading}><Search size={16} /> Search nearby</Button>
        </form>
        <Button className="locate-button" variant="outline" type="button" onClick={useCurrentLocation} disabled={locating}><LocateFixed size={16} /> {locating ? 'Locating…' : 'Use my location'}</Button>
      </CardContent></Card>

      <div className="results-heading">
        <div><h2>Restaurants nearby</h2><p>{resultsSummary}</p></div>
        <span className={`live-indicator ${socketState}`}><span /> {socketState === 'live' ? 'Live availability' : socketState === 'connecting' ? 'Connecting…' : 'Live updates paused'}</span>
      </div>

      <div className="list-toolbar">
        <Field className="toolbar-field"><Label htmlFor="sort">Sort by</Label>
          <select id="sort" value={criteria.sort} disabled={loading} onChange={(event) => applyCriteria({ sort: event.target.value })}>
            {SORT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </Field>
        <Field className="toolbar-field"><Label htmlFor="radius">Search radius</Label>
          <select id="radius" value={criteria.radiusMeters} disabled={loading} onChange={(event) => applyCriteria({ radiusMeters: Number(event.target.value) })}>
            {RADII.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </Field>
        <Button type="button" variant={criteria.openOnly ? 'default' : 'outline'} aria-pressed={criteria.openOnly} className="open-only-toggle" disabled={loading} onClick={() => applyCriteria({ openOnly: !criteria.openOnly })}>
          <Radio size={15} /> Open tables only
        </Button>
        {filtersActive && <Button type="button" variant="ghost" disabled={loading} onClick={() => applyCriteria({ openOnly: false, sort: INITIAL_CRITERIA.sort })}>Reset</Button>}
      </div>

      {error && <div role="alert" className="inline-error">{error}</div>}
      {loading ? <div className="restaurant-grid" aria-label="Loading restaurants">{[0, 1, 2].map((item) => <div className="restaurant-skeleton" key={item} />)}</div> : restaurants.length > 0 ? <div className="restaurant-grid">
        {restaurants.map((restaurant, index) => <Card className={`restaurant-card ${updatedId === String(restaurant.restaurantId) ? 'is-updated' : ''}`} key={restaurant.restaurantId ?? restaurant.googlePlaceId ?? restaurant.name}>
          <button className="restaurant-card-action" type="button" onClick={() => restaurant.restaurantId && navigate(`/restaurants/${restaurant.restaurantId}`)} disabled={!restaurant.restaurantId} aria-label={`View ${restaurant.name}`}>
            <div className="restaurant-photo-wrap"><img src={restaurant.photoUrl ?? photoFor(index)} alt="" loading="lazy" /><span className="photo-mark"><Utensils size={15} /></span></div>
            <CardContent className="restaurant-card-content">
              <div className="restaurant-card-top"><div><h3>{restaurant.name}</h3><p>{restaurant.address || restaurant.vicinity || 'Chennai'}</p></div><ArrowUpRight size={17} /></div>
              <div className="restaurant-card-bottom"><Availability counts={restaurant.availability} listed={restaurant.source === 'places'} /><span className="distance-label">{formatDistance(restaurant.distanceMeters)}</span></div>
            </CardContent>
          </button>
        </Card>)}
      </div> : <div className="empty-results"><span><MapPin size={20} /></span>
        <h3>{criteria.openOnly ? 'No open tables in this area' : 'No restaurants in this area yet'}</h3>
        <p>{criteria.openOnly ? 'Every nearby table is taken right now. Include fully booked places or widen the radius.' : 'Try adjusting your coordinates or widening the search location.'}</p>
        <div className="empty-results-actions">
          {criteria.openOnly && <Button variant="outline" onClick={() => applyCriteria({ openOnly: false })}>Show fully booked places</Button>}
          <Button variant={criteria.openOnly ? 'ghost' : 'default'} onClick={() => { setLatitude(String(DEFAULT_LOCATION.latitude)); setLongitude(String(DEFAULT_LOCATION.longitude)); setLocationLabel('Chennai, India'); void searchNearby(DEFAULT_LOCATION, { ...INITIAL_CRITERIA, radiusMeters: criteria.radiusMeters }); }}><Search size={16} /> Search Chennai</Button>
        </div>
      </div>}
    </main>
  </div>;
}
