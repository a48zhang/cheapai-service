import { lazy } from 'react';
import { Navigate } from 'react-router-dom';
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
const ImagesPage = lazy(() => import('../pages/images/ImagesPage'));
const ModelCatalogPage = lazy(() => import('../pages/catalog/ModelCatalogPage'));

export const personalPageRoutes = [
  { path: '/console/models', Page: ModelCatalogPage },
  { path: '/images', Page: ImagesPage },
  { path: '/keys', Page: KeysPage },
  { path: '/billing', Page: BillingPage },
  { path: '/requests', Page: RequestsPage },
  { path: '/requests/:id', Page: RequestDetailPage },
  { path: '/dashboard', Page: () => <Navigate replace to="/billing" /> },
];
