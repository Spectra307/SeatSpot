import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth/auth-context.jsx';
import { AuthPage } from './pages/auth-page.jsx';

function HomeRedirect() {
  const { token, claims } = useAuth();
  if (!token) return <Navigate to="/auth" replace />;
  return <Navigate to={claims?.role === 'staff' ? `/staff/${claims.restaurantId}` : '/restaurants'} replace />;
}

export function App() {
  return <Routes>
    <Route path="/auth" element={<AuthPage />} />
    <Route path="/" element={<HomeRedirect />} />
    <Route path="*" element={<Navigate to="/" replace />} />
  </Routes>;
}