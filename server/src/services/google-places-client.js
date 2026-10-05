const nearbyUrl = 'https://places.googleapis.com/v1/places:searchNearby';
const geocodeUrl = 'https://maps.googleapis.com/maps/api/geocode/json';

function cuisineFromPrimaryType(primaryType) {
  if (!primaryType) return undefined;
  const readable = String(primaryType).replace(/_/g, ' ').trim();
  return readable ? readable.replace(/\b\w/g, (letter) => letter.toUpperCase()) : undefined;
}

export class GooglePlacesClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
  }

  get enabled() {
    return Boolean(this.apiKey);
  }

  async searchNearby({ latitude, longitude, radiusMeters }) {
    if (!this.enabled) return [];
    const response = await fetch(nearbyUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': this.apiKey,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.primaryTypeDisplayName,places.primaryType'
      },
      body: JSON.stringify({
        includedTypes: ['restaurant'],
        maxResultCount: 20,
        locationRestriction: { circle: { center: { latitude, longitude }, radius: radiusMeters } }
      })
    });
    if (!response.ok) throw new Error(`Google Places request failed (${response.status})`);
    const payload = await response.json();
    return (payload.places ?? []).map((place) => ({
      googlePlaceId: place.id,
      name: place.displayName?.text,
      cuisine: place.primaryTypeDisplayName?.text ?? cuisineFromPrimaryType(place.primaryType),
      address: place.formattedAddress,
      location: place.location ? { type: 'Point', coordinates: [place.location.longitude, place.location.latitude] } : undefined
    }));
  }

  async geocode(query) {
    if (!this.enabled) throw new Error('Google Maps geocoding requires GOOGLE_MAPS_API_KEY');
    const url = new URL(geocodeUrl);
    url.searchParams.set('address', query);
    url.searchParams.set('key', this.apiKey);

    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Google Geocoding request failed (${response.status})`);
    const payload = await response.json();
    if (payload.status === 'ZERO_RESULTS') return null;
    if (payload.status !== 'OK') throw new Error(`Google Geocoding request failed (${payload.status})`);

    const [match] = payload.results ?? [];
    if (!match?.geometry?.location) return null;
    return {
      latitude: match.geometry.location.lat,
      longitude: match.geometry.location.lng,
      label: match.formatted_address ?? query
    };
  }
}