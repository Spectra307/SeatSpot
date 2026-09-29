import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth/auth-context.jsx';
import { AuthPage } from './pages/auth-page.jsx';
import { RestaurantListPage } from './pages/restaurant-list-page.jsx';
import { RestaurantDetailPage } from './pages/restaurant-detail-page.jsx';
import { StaffDashboardPage } from './pages/staff-dashboard-page.jsx';

function HomeRedirect() {
  const { token, claims } = useAuth();
  if (!token) return <Navigate to="/auth" replace />;
  return <Navigate to={claims?.role === 'staff' ? `/staff/${claims.restaurantId}` : '/restaurants'} replace />;
}

function RequireAuth({ children }) {
  const { token } = useAuth();
  return token ? children : <Navigate to="/auth" replace />;
}

export function App() {
  return <Routes>
    <Route path="/auth" element={<AuthPage />} />
    <Route path="/restaurants" element={<RequireAuth><RestaurantListPage /></RequireAuth>} />
    <Route path="/restaurants/:restaurantId" element={<RequireAuth><RestaurantDetailPage /></RequireAuth>} />
    <Route path="/staff/:restaurantId" element={<RequireAuth><StaffDashboardPage /></RequireAuth>} />
    <Route path="/" element={<HomeRedirect />} />
    <Route path="*" element={<Navigate to="/" replace />} />
  </Routes>;
}