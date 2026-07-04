import React, { Suspense, lazy } from 'react';
import { Navigate, Routes, Route, useParams } from 'react-router-dom';
import { Toaster } from 'sonner';
import { AuthProvider } from './contexts/AuthContext';
import { ThemeProvider } from './contexts/ThemeContext';
import { DisplayThemeProvider } from './contexts/DisplayThemeContext';
import { LiveDataProvider } from './contexts/LiveDataContext';
import Loading from './components/Loading';
import ErrorBoundary from './components/ErrorBoundary';
import { PUBLIC_DATA_READY_EVENT } from './utils/publicDataEvents';

const loadLayout = () => import('./pages/Layout');
const loadIndex = () => import('./pages/Index');
const loadInstance = () => import('./pages/Instance');
const loadLogin = () => import('./pages/Login');
const loadDbInit = () => import('./pages/DbInit');
const loadNotFound = () => import('./pages/NotFound');
const loadAdminDashboard = () => import('./pages/admin/Dashboard');
const loadAdminClients = () => import('./pages/admin/Clients');
const loadSettingsLayout = () => import('./pages/admin/SettingsLayout');
const loadSettingsSite = () => import('./pages/admin/SettingsSite');
const loadSettingsGeneral = () => import('./pages/admin/SettingsGeneral');

const Layout = lazy(loadLayout);
const Index = lazy(loadIndex);
const Instance = lazy(loadInstance);
const Login = lazy(loadLogin);
const DbInit = lazy(loadDbInit);
const NotFound = lazy(loadNotFound);

const AdminLayout = lazy(() => import('./pages/admin/AdminLayout'));
const AdminDashboard = lazy(loadAdminDashboard);
const AdminClients = lazy(loadAdminClients);
const AdminWebsites = lazy(() => import('./pages/admin/Websites'));
const SettingsLayout = lazy(loadSettingsLayout);
const SettingsSite = lazy(loadSettingsSite);
const SettingsGeneral = lazy(loadSettingsGeneral);
const AdminPingTasks = lazy(() => import('./pages/admin/PingTasks'));
const AdminNotifications = lazy(() => import('./pages/admin/Notifications'));
const AdminThemes = lazy(() => import('./pages/admin/Themes'));
const AdminLogs = lazy(() => import('./pages/admin/AuditLogs'));
const AdminAccount = lazy(() => import('./pages/admin/Account'));
const AdminAbout = lazy(() => import('./pages/admin/About'));

function preloadRouteChunks() {
  // ponytail: preload after first public data; per-route hover prefetch if this grows.
  void loadLayout();
  void loadIndex();
  void loadInstance();
  void loadLogin();
  void loadDbInit();
  void loadNotFound();
  void import('./pages/admin/AdminLayout');
  void loadAdminDashboard();
  void loadAdminClients();
  void import('./pages/admin/Websites');
  void loadSettingsLayout();
  void loadSettingsSite();
  void loadSettingsGeneral();
  void import('./pages/admin/PingTasks');
  void import('./pages/admin/Notifications');
  void import('./pages/admin/Themes');
  void import('./pages/admin/AuditLogs');
  void import('./pages/admin/Account');
  void import('./pages/admin/About');
}

function LiveDataRoute({
  children,
  enabled = true,
}: {
  children: React.ReactNode;
  enabled?: boolean;
}) {
  return <LiveDataProvider enabled={enabled} viewer>{children}</LiveDataProvider>;
}

function PublicIndexRoute() {
  return <Index />;
}

function LegacySettingsNotificationRedirect() {
  const { tab } = useParams<{ tab?: string }>();
  const allowedTabs = new Set(['settings', 'offline', 'expiry', 'load']);
  const targetTab = tab && allowedTabs.has(tab) ? tab : 'settings';
  return <Navigate to={`/admin/notifications/${targetTab}`} replace />;
}

function LegacyAdminNotificationRedirect() {
  const { tab } = useParams<{ tab?: string }>();
  const allowedTabs = new Set(['settings', 'offline', 'expiry', 'load']);
  const targetTab = tab && allowedTabs.has(tab) ? tab : 'settings';
  return <Navigate to={`/admin/notifications/${targetTab}`} replace />;
}

export default function App() {
  React.useEffect(() => {
    let preloaded = false;
    let idleId: number | null = null;
    const schedulePreload = () => {
      if (preloaded) return;
      preloaded = true;
      idleId = window.requestIdleCallback
        ? window.requestIdleCallback(preloadRouteChunks)
        : window.setTimeout(preloadRouteChunks, 0);
    };
    const timeoutId = window.setTimeout(schedulePreload, 30_000);
    window.addEventListener(PUBLIC_DATA_READY_EVENT, schedulePreload, { once: true });
    return () => {
      window.clearTimeout(timeoutId);
      window.removeEventListener(PUBLIC_DATA_READY_EVENT, schedulePreload);
      if (idleId !== null) {
        if (window.cancelIdleCallback) window.cancelIdleCallback(idleId);
        else window.clearTimeout(idleId);
      }
    };
  }, []);

  return (
    <ThemeProvider>
      <DisplayThemeProvider>
        <AuthProvider>
          <ErrorBoundary>
            <Suspense fallback={<Loading fullScreen />}>
              <Routes>
                <Route path="/" element={<Layout />}>
                  <Route index element={<LiveDataRoute><PublicIndexRoute /></LiveDataRoute>} />
                  <Route path="instance/:uuid" element={<LiveDataRoute><Instance /></LiveDataRoute>} />
                </Route>

                <Route path="/login" element={<Login />} />
                <Route path="/admin/login" element={<Login />} />
                <Route path="/db-init" element={<DbInit />} />

                <Route path="/admin" element={<AdminLayout />}>
                  <Route index element={<LiveDataRoute><AdminDashboard /></LiveDataRoute>} />
                  <Route path="clients" element={<AdminClients />} />
                  <Route path="websites" element={<AdminWebsites />} />
                  <Route path="settings" element={<SettingsLayout />}>
                    <Route index element={<SettingsSite />} />
                    <Route path="site" element={<SettingsSite />} />
                    <Route path="notification" element={<Navigate to="/admin/notifications/settings" replace />} />
                    <Route path="notification/:tab" element={<LegacySettingsNotificationRedirect />} />
                    <Route path="general" element={<SettingsGeneral />} />
                  </Route>
                  <Route path="ping" element={<AdminPingTasks />} />
                  <Route path="notifications" element={<AdminNotifications />} />
                  <Route path="notifications/:tab" element={<AdminNotifications />} />
                  <Route path="notification" element={<Navigate to="/admin/notifications/settings" replace />} />
                  <Route path="notification/:tab" element={<LegacyAdminNotificationRedirect />} />
                  <Route path="themes" element={<AdminThemes />} />
                  <Route path="logs" element={<AdminLogs />} />
                  <Route path="account" element={<AdminAccount />} />
                  <Route path="about" element={<AdminAbout />} />
                </Route>

                <Route path="*" element={<NotFound />} />
              </Routes>
            </Suspense>
          </ErrorBoundary>
          <Toaster
            position="bottom-right"
            richColors
            closeButton
            duration={4000}
            style={{ fontFamily: 'inherit' }}
          />
        </AuthProvider>
      </DisplayThemeProvider>
    </ThemeProvider>
  );
}
