import { Navigate, createHashRouter } from 'react-router';
import { AppShell } from '@/layouts/AppShell';
import { AccountPage } from '@/pages/account/AccountPage';
import { AddressBookPage } from '@/pages/address-book/AddressBookPage';
import { DashboardPage } from '@/pages/dashboard/DashboardPage';
import { DevicesPage } from '@/pages/devices/DevicesPage';
import { NotFoundPage, RouteErrorPage } from '@/pages/errors/ErrorPages';
import { SessionsPage } from '@/pages/sessions/SessionsPage';
import { SettingsLayout, SettingsSectionPage } from '@/pages/settings/SettingsPage';
import { TransfersPage } from '@/pages/transfers/TransfersPage';
import { HostSessionPage } from '@/pages/host-session/HostSessionPage';
import { ViewerPage } from '@/pages/viewer/ViewerPage';

/**
 * Hash routing: the packaged app loads index.html from disk (file://), where
 * path-based routes cannot be resolved on reload.
 */
export const router = createHashRouter([
  {
    path: '/',
    element: <AppShell />,
    errorElement: <RouteErrorPage />,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: 'devices', element: <DevicesPage /> },
      { path: 'sessions', element: <SessionsPage /> },
      { path: 'transfers', element: <TransfersPage /> },
      { path: 'address-book', element: <AddressBookPage /> },
      {
        path: 'settings',
        element: <SettingsLayout />,
        children: [
          { index: true, element: <Navigate to="general" replace /> },
          { path: ':section', element: <SettingsSectionPage /> },
        ],
      },
      { path: 'account', element: <AccountPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
  // The viewer is full-window, outside the main shell.
  { path: '/session/:deviceId', element: <ViewerPage />, errorElement: <RouteErrorPage /> },
  // The remote side's always-visible session indicator (its own window).
  {
    path: '/host-session/:sessionId',
    element: <HostSessionPage />,
    errorElement: <RouteErrorPage />,
  },
]);
