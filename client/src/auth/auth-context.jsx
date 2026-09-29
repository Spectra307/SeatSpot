import { createContext, useContext, useEffect, useState } from 'react';
import { parseJwt } from '../lib/api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [token, setToken] = useState(() => localStorage.getItem('seatspot.token'));
  const claims = token ? parseJwt(token) : null;

  useEffect(() => {
    const clearSession = () => setToken(null);
    window.addEventListener('seatspot:session-expired', clearSession);
    return () => window.removeEventListener('seatspot:session-expired', clearSession);
  }, []);

  function saveToken(nextToken) {
    localStorage.setItem('seatspot.token', nextToken);
    setToken(nextToken);
  }

  function logout() {
    localStorage.removeItem('seatspot.token');
    setToken(null);
  }

  return <AuthContext.Provider value={{ token, claims, saveToken, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}