import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthLayout } from './layouts/AuthLayout';
import { ConsoleLayout } from './layouts/ConsoleLayout';
import { SessionBoundary } from './guards/SessionBoundary';
import { AdminBoundary } from './guards/AdminBoundary';
import { AdminLayout } from './layouts/AdminLayout';

const LoginPage = lazy(() => import('../pages/auth/LoginPage'));
const RegisterPage = lazy(() => import('../pages/auth/RegisterPage'));
const SessionUnavailablePage = lazy(() => import('../pages/auth/SessionUnavailablePage'));
const NotFoundPage = lazy(() => import('../pages/NotFoundPage'));
const DashboardPage = lazy(() =>
  import('../pages/dashboard/DashboardPage').then((module) => ({ default: module.DashboardPage })),
);
const RequestsPage = lazy(() =>
  import('../pages/requests/RequestsPage').then((module) => ({ default: module.RequestsPage })),
);
const RequestDetailPage = lazy(() =>
  import('../pages/requests/RequestDetailPage').then((module) => ({
    default: module.RequestDetailPage,
  })),
);
const BillingPage = lazy(() =>
  import('../pages/billing/BillingPage').then((module) => ({ default: module.BillingPage })),
);
const KeysPage = lazy(() => import('../pages/keys/KeysPage'));
const ChatPage = lazy(() => import('../pages/chat/ChatPage'));
const ChannelsPage = lazy(() => import('../pages/admin/ChannelsPage'));
const ChannelDetailPage = lazy(() => import('../pages/admin/ChannelDetailPage'));
const ModelsPage = lazy(() => import('../pages/admin/ModelsPage'));
const ModelDetailPage = lazy(() => import('../pages/admin/ModelDetailPage'));
const GroupsPage = lazy(() => import('../pages/admin/GroupsPage'));
const GroupDetailPage = lazy(() => import('../pages/admin/GroupDetailPage'));
const UsersPage = lazy(() => import('../pages/admin/UsersPage'));
const UserDetailPage = lazy(() => import('../pages/admin/UserDetailPage'));
const AdminRequestsPage = lazy(() => import('../pages/admin/RequestsPage'));
const AdminRequestDetailPage = lazy(() => import('../pages/admin/RequestDetailPage'));
const AdminBillingPage = lazy(() => import('../pages/admin/BillingPage'));
const AuditPage = lazy(() => import('../pages/admin/AuditPage'));
const RegistrationSettingsPage = lazy(() => import('../pages/admin/RegistrationSettingsPage'));
const RegistrationCodesPage = lazy(() => import('../pages/admin/RegistrationCodesPage'));

export function AppRoutes() {
  return (
    <Suspense
      fallback={
        <p role="status" className="p-8">
          正在加载…
        </p>
      }
    >
      <Routes>
        <Route element={<AuthLayout />}>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/session-unavailable" element={<SessionUnavailablePage />} />
        </Route>
        <Route element={<SessionBoundary />}>
          <Route element={<ConsoleLayout />}>
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/keys" element={<KeysPage />} />
            <Route path="/requests" element={<RequestsPage />} />
            <Route path="/requests/:id" element={<RequestDetailPage />} />
            <Route path="/billing" element={<BillingPage />} />
          </Route>
          <Route element={<AdminBoundary />}>
            <Route element={<AdminLayout />}>
              <Route path="/admin" element={<Navigate replace to="/admin/channels" />} />
              <Route path="/admin/channels" element={<ChannelsPage />} />
              <Route path="/admin/channels/:channelId" element={<ChannelDetailPage />} />
              <Route path="/admin/models" element={<ModelsPage />} />
              <Route path="/admin/models/actions/create" element={<ModelDetailPage createMode />} />
              <Route path="/admin/models/:id" element={<ModelDetailPage />} />
              <Route path="/admin/groups" element={<GroupsPage />} />
              <Route path="/admin/groups/:id" element={<GroupDetailPage />} />
              <Route path="/admin/users" element={<UsersPage />} />
              <Route path="/admin/users/:id" element={<UserDetailPage />} />
              <Route path="/admin/requests" element={<AdminRequestsPage />} />
              <Route path="/admin/requests/:id" element={<AdminRequestDetailPage />} />
              <Route path="/admin/billing" element={<AdminBillingPage />} />
              <Route path="/admin/audit" element={<AuditPage />} />
              <Route path="/admin/registration/settings" element={<RegistrationSettingsPage />} />
              <Route path="/admin/registration/codes" element={<RegistrationCodesPage />} />
            </Route>
          </Route>
        </Route>
        <Route path="/" element={<ChatPage />} />
        <Route path="/chat/:id" element={<ChatPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </Suspense>
  );
}
