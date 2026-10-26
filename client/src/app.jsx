import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth/auth-context.jsx';
import { AuthPage } from './pages/auth-page.jsx';
import { RestaurantListPage } from './pages/restaurant-list-page.jsx';
import { RestaurantDetailPage } from './pages/restaurant-detail-page.jsx';
import { StaffDashboardPage } from './pages/staff-dashboard-page.jsx';
import { BookingsPage } from './pages/bookings-page.jsx';

function HomeRedirect() {
  const { token, claims } = useAuth();
  if (!token) return <Navigate to="/auth" replace />;
  return <Navigate to={claims?.role === 'staff' ? `/staff/${claims.restaurantId}` : '/restaurants'} replace />;
}

function RequireAuth({ children }) {
  const { token } = useAuth();
  return token ? children : <Navigate to="/auth" replace />;
}

function RequireCustomer({ children }) {
  const { token, claims } = useAuth();
  if (!token) return <Navigate to="/auth" replace />;
  if (claims?.role === 'staff') return <Navigate to={claims.restaurantId ? `/staff/${claims.restaurantId}` : '/'} replace />;
  return children;
}

export function App() {
  return <Routes>
    <Route path="/auth" element={<AuthPage />} />
    <Route path="/restaurants" element={<RequireCustomer><RestaurantListPage /></RequireCustomer>} />
    <Route path="/restaurants/:restaurantId" element={<RequireCustomer><RestaurantDetailPage /></RequireCustomer>} />
    <Route path="/bookings" element={<RequireCustomer><BookingsPage /></RequireCustomer>} />
    <Route path="/staff/:restaurantId" element={<RequireAuth><StaffDashboardPage /></RequireAuth>} />
    <Route path="/" element={<HomeRedirect />} />
    <Route path="*" element={<Navigate to="/" replace />} />
  </Routes>;
}