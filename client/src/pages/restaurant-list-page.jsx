import { useCallback, useEffect, useState } from 'react';
import { ArrowUpRight, LocateFixed, MapPin, Search, Utensils } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { AppHeader } from '../components/app-header.jsx';
import { Badge } from '../components/ui/badge.jsx';
import { Button } from '../components/ui/button.jsx';
import { Card, CardContent } from '../components/ui/card.jsx';
import { Field, Label } from '../components/ui/field.jsx';
import { Input } from '../components/ui/input.jsx';
import { api } from '../lib/api.js';

const DEFAULT_LOCATION = { latitude: 12.9255, longitude: 80.2201 };
const restaurantPhotos = [
  'photo-1414235077428-338989a2e8c0',
  'photo-1517248135467-4c7edcad34c4',
  'photo-1514933651103-005eec06c04b',
  'photo-1559339352-11d035aa65de'
];
const photoFor = (index) => `https://images.unsplash.com/${restaurantPhotos[index % restaurantPhotos.length]}?auto=format&fit=crop&w=900&q=82`;

function Availability({ counts }) {
  const available = counts?.available ?? 0;
  const total = counts?.total ?? 0;
  return <Badge variant={available > 0 ? 'success' : 'muted'} className="gap-1.5 px-2.5 py-1">
    <span className={`size-1.5 rounded-full ${available ? 'bg-emerald-600' : 'bg-slate-400'}`} />
    {available} of {total} tables open
  </Badge>;
}

export function RestaurantListPage() {
  const [latitude, setLatitude] = useState(String(DEFAULT_LOCATION.latitude));
  const [longitude, setLongitude] = useState(String(DEFAULT_LOCATION.longitude));
  const [restaurants, setRestaurants] = useState([]);
  const [loading, setLoading] = useState(true);
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState('');
  const [locationLabel, setLocationLabel] = useState('Chennai, India');
  const navigate = useNavigate();

  const searchNearby = useCallback(async (point) => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ latitude: String(point.latitude), longitude: String(point.longitude), radiusMeters: '12000' });
      const result = await api(`/restaurants/nearby?${params}`);
      setRestaurants(result.restaurants ?? []);
    } catch (requestError) {
      setError(requestError.message || 'Restaurant search is unavailable.');
      if (requestError.status !== 401) toast.error('Search could not be completed', { description: requestError.message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!navigator.geolocation) {
      void searchNearby(DEFAULT_LOCATION);
      return () => { cancelled = true; };
    }
    navigator.geolocation.getCurrentPosition((position) => {
      if (cancelled) return;
      const point = { latitude: position.coords.latitude, longitude: position.coords.longitude };
      setLatitude(point.latitude.toFixed(4));
      setLongitude(point.longitude.toFixed(4));
      setLocationLabel('Your current location');
      void searchNearby(point);
    }, () => {
      if (!cancelled) void searchNearby(DEFAULT_LOCATION);
    }, { enableHighAccuracy: false, timeout: 7000, maximumAge: 120000 });
    return () => { cancelled = true; };
  }, [searchNearby]);

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
      void searchNearby(point);
    }, () => {
      setLocating(false);
      toast.error('Could not get your location', { description: 'Enter coordinates manually to search nearby.' });
    }, { enableHighAccuracy: false, timeout: 10000 });
  }

  function handleManualSearch(event) {
    event.preventDefault();
    const point = { latitude: Number(latitude), longitude: Number(longitude) };
    if (!Number.isFinite(point.latitude) || !Number.isFinite(point.longitude) || Math.abs(point.latitude) > 90 || Math.abs(point.longitude) > 180) {
      toast.error('Enter valid coordinates', { description: 'Latitude must be within ±90 and longitude within ±180.' });
      return;
    }
    setLocationLabel('Selected coordinates');
    void searchNearby(point);
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
        <div><h2>Restaurants nearby</h2><p>{loading ? 'Checking live availability…' : `${restaurants.length} places within 12 km`}</p></div>
        <span className="live-indicator"><span /> Live availability</span>
      </div>

      {error && <div role="alert" className="inline-error">{error}</div>}
      {loading ? <div className="restaurant-grid" aria-label="Loading restaurants">{[0, 1, 2].map((item) => <div className="restaurant-skeleton" key={item} />)}</div> : restaurants.length > 0 ? <div className="restaurant-grid">
        {restaurants.map((restaurant, index) => <Card className="restaurant-card" key={restaurant.restaurantId ?? restaurant.googlePlaceId ?? restaurant.name}>
          <button className="restaurant-card-action" type="button" onClick={() => restaurant.restaurantId && navigate(`/restaurants/${restaurant.restaurantId}`)} disabled={!restaurant.restaurantId} aria-label={`View ${restaurant.name}`}>
            <div className="restaurant-photo-wrap"><img src={restaurant.photoUrl ?? photoFor(index)} alt="" loading="lazy" /><span className="photo-mark"><Utensils size={15} /></span></div>
            <CardContent className="restaurant-card-content">
              <div className="restaurant-card-top"><div><h3>{restaurant.name}</h3><p>{restaurant.address || restaurant.vicinity || 'Chennai'}</p></div><ArrowUpRight size={17} /></div>
              <div className="restaurant-card-bottom"><Availability counts={restaurant.availability} /><span className="distance-label">{restaurant.distance ? `${(restaurant.distance / 1000).toFixed(1)} km` : 'Nearby'}</span></div>
            </CardContent>
          </button>
        </Card>)}
      </div> : <div className="empty-results"><span><MapPin size={20} /></span><h3>No restaurants in this area yet</h3><p>Try adjusting your coordinates or widening the search location.</p><Button variant="outline" onClick={() => { setLatitude(String(DEFAULT_LOCATION.latitude)); setLongitude(String(DEFAULT_LOCATION.longitude)); setLocationLabel('Chennai, India'); void searchNearby(DEFAULT_LOCATION); }}><Search size={16} /> Search Chennai</Button></div>}
    </main>
  </div>;
}
