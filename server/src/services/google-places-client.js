const nearbyUrl = 'https://places.googleapis.com/v1/places:searchNearby';

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
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location'
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
      address: place.formattedAddress,
      location: place.location ? { type: 'Point', coordinates: [place.location.longitude, place.location.latitude] } : undefined
    }));
  }
}
