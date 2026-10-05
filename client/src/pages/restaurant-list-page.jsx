import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, LoaderCircle, LocateFixed, MapPin, Minus, Plus, Radio, Search, Store, Users, Utensils } from 'lucide-react';
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
const DEFAULT_AREA_LABEL = 'Chennai, India';
const INITIAL_CRITERIA = { radiusMeters: 12000, sort: 'distance', openOnly: false, partySize: 2, fitsParty: false };
const MAX_PARTY_SIZE = 12;
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

function availabilityLabel(restaurant) {
  const available = restaurant.availability?.available ?? 0;
  const total = restaurant.availability?.total ?? 0;
  if (available === 0) return total > 0 ? 'Full — join queue' : 'No tables listed';
  return `${available} ${available === 1 ? 'table' : 'tables'} free`;
}

function Availability({ restaurant, listed, partySize }) {
  if (listed) return <Badge variant="outline" className="gap-1.5 px-2.5 py-1"><Store size={13} /> Google listing</Badge>;
  const available = restaurant.availability?.available ?? 0;
  const total = restaurant.availability?.total ?? 0;
  const fitsParty = restaurant.tablesForParty;
  return <Badge variant={available > 0 ? 'default' : 'warning'} className={`availability-badge ${available > 0 ? 'is-free' : 'is-full'} gap-1.5 px-2.5 py-1`}>
    <span className="availability-dot" />
    {availabilityLabel(restaurant)}
    {total > 0 && <span className="availability-total">/ {total}</span>}
    {available > 0 && fitsParty > 0 && fitsParty < available && <span className="availability-fits">· {fitsParty} fit {partySize}</span>}
  </Badge>;
}


export function RestaurantListPage() {
  const { token } = useAuth();
  const [criteria, setCriteria] = useState(INITIAL_CRITERIA);
  const [origin, setOrigin] = useState(DEFAULT_LOCATION);
  const [areaQuery, setAreaQuery] = useState('');
  const [geocoding, setGeocoding] = useState(false);
  const [areaError, setAreaError] = useState('');
  const [restaurants, setRestaurants] = useState([]);
  const [loading, setLoading] = useState(true);
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState('');
  const [locationLabel, setLocationLabel] = useState(DEFAULT_AREA_LABEL);
  const [socketState, setSocketState] = useState('connecting');
  const [updatedId, setUpdatedId] = useState('');
  const socketRef = useRef(null);
  const requestRef = useRef(0);
  const searchSeqRef = useRef(0);
  const flashRef = useRef(null);
  const reconcileRef = useRef(null);
  const originRef = useRef(DEFAULT_LOCATION);
  const criteriaRef = useRef(INITIAL_CRITERIA);
  const navigate = useNavigate();

  const partySize = criteria.partySize;

  const flashRestaurant = useCallback((restaurantId) => {
    setUpdatedId(restaurantId);
    clearTimeout(flashRef.current);
    flashRef.current = setTimeout(() => setUpdatedId(''), 1400);
  }, []);

  const buildQuery = useCallback((point, nextCriteria) => new URLSearchParams({
    latitude: String(point.latitude),
    longitude: String(point.longitude),
    radiusMeters: String(nextCriteria.radiusMeters),
    sort: nextCriteria.sort,
    openOnly: nextCriteria.openOnly ? 'true' : 'false',
    partySize: String(nextCriteria.partySize),
    fitsParty: nextCriteria.fitsParty ? 'true' : 'false',
    limit: String(MAX_RESULTS)
  }), []);

  const searchNearby = useCallback(async (point, nextCriteria) => {
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    searchSeqRef.current = requestId;
    clearTimeout(reconcileRef.current);
    setLoading(true);
    setError('');
    try {
      const result = await api(`/restaurants/nearby?${buildQuery(point, nextCriteria)}`);
      if (requestRef.current !== requestId) return;
      setRestaurants(result.restaurants ?? []);
      setOrigin(point);
      setCriteria(nextCriteria);
      originRef.current = point;
      criteriaRef.current = nextCriteria;
    } catch (requestError) {
      if (requestRef.current !== requestId) return;
      setError(requestError.message || 'Restaurant search is unavailable.');
      if (requestError.status !== 401) toast.error('Search could not be completed', { description: requestError.message });
    } finally {
      if (requestRef.current === requestId) setLoading(false);
    }
  }, [buildQuery]);

  // A live availability event only carries the table counts, so the "tables that fit
  // your party" figure and the party filter would otherwise drift. Re-read the current
  // search silently to reconcile, without flashing the loading skeleton.
  const reconcileLiveCounts = useCallback(() => {
    const expected = searchSeqRef.current;
    clearTimeout(reconcileRef.current);
    reconcileRef.current = setTimeout(async () => {
      if (searchSeqRef.current !== expected) return;
      try {
        const result = await api(`/restaurants/nearby?${buildQuery(originRef.current, criteriaRef.current)}`);
        if (searchSeqRef.current !== expected) return;
        setRestaurants(result.restaurants ?? []);
      } catch {
        // Keep the optimistic counts already on screen rather than blanking the list.
      }
    }, 500);
  }, [buildQuery]);


  useEffect(() => {
    let cancelled = false;
    const search = (point, label) => {
      if (cancelled) return;
      if (label) setLocationLabel(label);
      void searchNearby(point, INITIAL_CRITERIA);
    };
    if (!navigator.geolocation) {
      search(DEFAULT_LOCATION);
      return () => { cancelled = true; };
    }
    navigator.geolocation.getCurrentPosition((position) => {
      search({ latitude: position.coords.latitude, longitude: position.coords.longitude }, 'Your current location');
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
      reconcileLiveCounts();
    });
    return () => {
      socketRef.current = null;
      clearTimeout(flashRef.current);
      clearTimeout(reconcileRef.current);
      socket.disconnect();
    };
  }, [token, navigate, flashRestaurant, reconcileLiveCounts]);

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
    : `${restaurants.length} ${restaurants.length === 1 ? 'place' : 'places'} within ${radiusLabel}`
      + `${criteria.fitsParty ? ` that can seat ${partySize}` : ''}${hasTableCounts ? ` · ${openCount} with tables free` : ''}`;
  const filtersActive = criteria.openOnly || criteria.sort !== INITIAL_CRITERIA.sort || criteria.fitsParty || partySize !== INITIAL_CRITERIA.partySize;

  function useCurrentLocation() {
    if (!navigator.geolocation) {
      toast.error('Geolocation is not available in this browser', { description: 'Search for an area instead.' });
      return;
    }
    setLocating(true);
    setAreaError('');
    navigator.geolocation.getCurrentPosition((position) => {
      const point = { latitude: position.coords.latitude, longitude: position.coords.longitude };
      setLocationLabel('Your current location');
      setLocating(false);
      void searchNearby(point, criteria);
    }, (locationError) => {
      setLocating(false);
      toast.error('Could not get your location', { description: locationError?.message || 'Search for an area instead.' });
    }, { enableHighAccuracy: false, timeout: 10000 });
  }

  async function handleAreaSearch(event) {
    event.preventDefault();
    const query = areaQuery.trim();
    if (query.length < 3) {
      setAreaError('Enter at least 3 characters, for example "Anna Nagar" or "Chennai".');
      return;
    }
    setGeocoding(true);
    setAreaError('');
    try {
      const result = await api(`/restaurants/geocode?q=${encodeURIComponent(query)}`);
      const point = { latitude: result.location.latitude, longitude: result.location.longitude };
      setLocationLabel(result.location.label || query);
      await searchNearby(point, criteria);
    } catch (lookupError) {
      setAreaError(lookupError.message || 'Area lookup failed.');
    } finally {
      setGeocoding(false);
    }
  }

  function applyCriteria(patch) {
    void searchNearby(origin, { ...criteria, ...patch });
  }

  function changePartySize(next) {
    applyCriteria({ partySize: Math.max(1, Math.min(MAX_PARTY_SIZE, next)) });
  }

  function openRestaurant(restaurant) {
    if (!restaurant.restaurantId) return;
    navigate(`/restaurants/${restaurant.restaurantId}`, { state: { partySize } });
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
        <div className="locate-primary">
          <Button type="button" size="lg" className="locate-button" onClick={useCurrentLocation} disabled={locating}>
            {locating ? <LoaderCircle className="animate-spin" size={18} /> : <LocateFixed size={18} />}
            {locating ? 'Finding you…' : 'Use my location'}
          </Button>
          <p>Fastest way to see tables open around you right now.</p>
        </div>
        <form onSubmit={handleAreaSearch} className="area-search">
          <Field>
            <Label htmlFor="area">Or search an area</Label>
            <div className="input-icon-wrap">
              <Search size={16} />
              <Input
                id="area"
                name="area"
                type="search"
                autoComplete="off"
                placeholder="Search by area, e.g. Chennai, Anna Nagar"
                value={areaQuery}
                disabled={geocoding}
                onChange={(event) => { setAreaQuery(event.target.value); if (areaError) setAreaError(''); }}
              />
            </div>
          </Field>
          <Button type="submit" variant="outline" disabled={geocoding}>
            {geocoding ? <LoaderCircle className="animate-spin" size={16} /> : <MapPin size={16} />}
            {geocoding ? 'Locating…' : 'Search'}
          </Button>
        </form>
        {areaError && <p role="alert" className="area-error">{areaError}</p>}
      </CardContent></Card>

      <div className="results-heading">
        <div><h2>Restaurants nearby</h2><p>{resultsSummary}</p></div>
        <span className={`live-indicator ${socketState}`}><span /> {socketState === 'live' ? 'Live availability' : socketState === 'connecting' ? 'Connecting…' : 'Live updates paused'}</span>
      </div>

      <div className="list-toolbar">
        <Field className="toolbar-field party-size-field">
          <Label id="party-size-label"><Users size={13} /> Party size: {partySize}</Label>
          <div className="stepper stepper-compact" role="group" aria-labelledby="party-size-label" title={`Shows tables that can seat ${partySize}. Also pre-fills party size when you book.`}>
            <Button type="button" variant="outline" size="icon" aria-label="Decrease party size" disabled={partySize <= 1 || loading} onClick={() => changePartySize(partySize - 1)}><Minus size={15} /></Button>
            <output aria-live="polite">{partySize}</output>
            <Button type="button" variant="outline" size="icon" aria-label="Increase party size" disabled={partySize >= MAX_PARTY_SIZE || loading} onClick={() => changePartySize(partySize + 1)}><Plus size={15} /></Button>
          </div>
        </Field>
        <Button type="button" variant={criteria.fitsParty ? 'default' : 'outline'} aria-pressed={criteria.fitsParty} className="open-only-toggle" disabled={loading} onClick={() => applyCriteria({ fitsParty: !criteria.fitsParty })}>
          <Utensils size={15} /> Can seat {partySize}
        </Button>
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
        {filtersActive && <Button type="button" variant="ghost" disabled={loading} onClick={() => applyCriteria({ ...INITIAL_CRITERIA, radiusMeters: criteria.radiusMeters })}>Reset</Button>}
      </div>

      {error && <div role="alert" className="inline-error">{error}</div>}
      {loading ? <div className="restaurant-grid" aria-label="Loading restaurants">{[0, 1, 2].map((item) => <div className="restaurant-skeleton" key={item} />)}</div> : restaurants.length > 0 ? <div className="restaurant-grid">
        {restaurants.map((restaurant, index) => <Card className={`restaurant-card ${updatedId === String(restaurant.restaurantId) ? 'is-updated' : ''}`} key={restaurant.restaurantId ?? restaurant.googlePlaceId ?? restaurant.name}>
          <button className="restaurant-card-action" type="button" onClick={() => openRestaurant(restaurant)} disabled={!restaurant.restaurantId} aria-label={`View ${restaurant.name}${restaurant.cuisine ? `, ${restaurant.cuisine}` : ''}, ${availabilityLabel(restaurant)}`}>
            <div className="restaurant-photo-wrap"><img src={restaurant.photoUrl ?? photoFor(index)} alt="" loading="lazy" /><span className="photo-mark"><Utensils size={15} /></span></div>
            <CardContent className="restaurant-card-content">
              <div className="restaurant-card-top"><div><h3>{restaurant.name}</h3><p>{restaurant.address || restaurant.vicinity || 'Chennai'}</p></div><ArrowUpRight size={17} /></div>
              {restaurant.cuisine && <span className="cuisine-tag">{restaurant.cuisine}</span>}
              <div className="restaurant-card-bottom"><Availability restaurant={restaurant} listed={restaurant.source === 'places'} partySize={partySize} /><span className="distance-label">{formatDistance(restaurant.distanceMeters)}</span></div>
            </CardContent>
          </button>
        </Card>)}
      </div> : <div className="empty-results"><span><MapPin size={20} /></span>
        <h3>{criteria.fitsParty && partySize > 2 ? `No nearby table seats ${partySize}` : criteria.openOnly ? 'No open tables in this area' : 'No restaurants in this area yet'}</h3>
        <p>{criteria.fitsParty && partySize > 2 ? `Every free table around here is smaller than ${partySize}. Lower the party size or include places that cannot seat you yet.` : criteria.openOnly ? 'Every nearby table is taken right now. Include fully booked places or widen the radius.' : 'Use your location or search a different area name.'}</p>
        <div className="empty-results-actions">
          {criteria.fitsParty && partySize > 2 && <Button variant="outline" onClick={() => changePartySize(Math.max(1, partySize - 2))}>Lower party size</Button>}
          {criteria.fitsParty && <Button variant="outline" onClick={() => applyCriteria({ fitsParty: false })}>Show places that cannot seat {partySize}</Button>}
          {criteria.openOnly && <Button variant="outline" onClick={() => applyCriteria({ openOnly: false })}>Show fully booked places</Button>}
          <Button variant={criteria.openOnly || criteria.fitsParty ? 'ghost' : 'default'} onClick={() => { setLocationLabel(DEFAULT_AREA_LABEL); void searchNearby(DEFAULT_LOCATION, { ...INITIAL_CRITERIA, radiusMeters: criteria.radiusMeters }); }}><Search size={16} /> Search Chennai</Button>
        </div>
      </div>}
    </main>
  </div>;
}