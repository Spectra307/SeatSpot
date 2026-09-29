const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '/api';

export class ApiError extends Error {
  constructor(status, payload) {
    super(payload?.error ?? `Request failed (${status})`);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
  }
}

export async function api(path, { token, ...options } = {}) {
  const accessToken = token ?? localStorage.getItem('seatspot.token');
  const headers = new Headers(options.headers ?? {});
  if (accessToken) headers.set('authorization', `Bearer ${accessToken}`);
  if (options.body && !(options.body instanceof FormData)) headers.set('content-type', 'application/json');

  const response = await fetch(`${API_BASE}${path}`, { ...options, headers });
  const raw = await response.text();
  const payload = raw ? JSON.parse(raw) : undefined;
  if (response.status === 401 && accessToken) {
    localStorage.removeItem('seatspot.token');
    window.dispatchEvent(new CustomEvent('seatspot:session-expired'));
  }
  if (!response.ok) throw new ApiError(response.status, payload);
  return payload;
}

export function parseJwt(token) {
  try {
    return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return null;
  }
}