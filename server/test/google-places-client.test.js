import test from 'node:test';
import assert from 'node:assert/strict';
import { GooglePlacesClient } from '../src/services/google-places-client.js';

async function withFetch(handler, run) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

function jsonResponse(payload, ok = true, status = 200) {
  return { ok, status, async json() { return payload; } };
}

test('geocode turns an area name into coordinates and a readable label', async () => {
  const client = new GooglePlacesClient('test-key');
  let requested;
  const result = await withFetch(
    async (url) => {
      requested = url;
      return jsonResponse({
        status: 'OK',
        results: [{
          formatted_address: 'Anna Nagar, Chennai, Tamil Nadu 040040, India',
          geometry: { location: { lat: 13.0827, lng: 80.2707 } }
        }]
      });
    },
    () => client.geocode('Anna Nagar')
  );

  assert.deepEqual(result, {
    latitude: 13.0827,
    longitude: 80.2707,
    label: 'Anna Nagar, Chennai, Tamil Nadu 040040, India'
  });
  assert.equal(requested.searchParams.get('address'), 'Anna Nagar');
  assert.equal(requested.searchParams.get('key'), 'test-key');
  assert.match(requested.origin + requested.pathname, /maps\.googleapis\.com/);
});

test('geocode reports no match instead of guessing a location', async () => {
  const client = new GooglePlacesClient('test-key');
  const result = await withFetch(async () => jsonResponse({ status: 'ZERO_RESULTS', results: [] }), () => client.geocode('Nowhereville'));
  assert.equal(result, null);
});

test('geocode surfaces provider failures and missing configuration', async () => {
  const client = new GooglePlacesClient('test-key');
  await assert.rejects(
    withFetch(async () => jsonResponse({ status: 'OVER_QUERY_LIMIT' }), () => client.geocode('Anna Nagar')),
    /OVER_QUERY_LIMIT/
  );
  await assert.rejects(
    withFetch(async () => jsonResponse({}, false, 503), () => client.geocode('Anna Nagar')),
    /\(503\)/
  );
  await assert.rejects(() => new GooglePlacesClient('').geocode('Anna Nagar'), /GOOGLE_MAPS_API_KEY/);
});

test('nearby places carry a cuisine tag and request the fields that provide it', async () => {
  const client = new GooglePlacesClient('test-key');
  let fieldMask;
  const places = await withFetch(
    async (_url, options) => {
      fieldMask = options.headers['X-Goog-FieldMask'];
      return jsonResponse({
        places: [
          {
            id: 'place-1',
            displayName: { text: 'Riverside Grill' },
            formattedAddress: '12 Beach Road',
            primaryType: 'italian_restaurant',
            location: { latitude: 12.9351, longitude: 80.2301 }
          },
          { id: 'place-2', displayName: { text: 'Corner Cafe' }, primaryTypeDisplayName: { text: 'Coffee shop' } }
        ]
      });
    },
    () => client.searchNearby({ latitude: 12.9, longitude: 80.2, radiusMeters: 5000 })
  );

  assert.equal(places[0].cuisine, 'Italian Restaurant');
  assert.equal(places[1].cuisine, 'Coffee shop');
  assert.match(fieldMask, /places\.primaryTypeDisplayName/);
  assert.match(fieldMask, /places\.primaryType/);
  assert.deepEqual(places[0].location, { type: 'Point', coordinates: [80.2301, 12.9351] });
});

test('a client without a key is disabled and never calls Google', async () => {
  const client = new GooglePlacesClient('');
  assert.equal(client.enabled, false);
  await withFetch(async () => { throw new Error('fetch must not be called'); }, async () => {
    assert.deepEqual(await client.searchNearby({ latitude: 12.9, longitude: 80.2, radiusMeters: 5000 }), []);
  });
});