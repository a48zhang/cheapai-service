import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import RequestsPage from './RequestsPage';
import AuditPage from './AuditPage';
import { parseLocalDateTime } from '../../shared/lib/datetime';

vi.mock('../../features/session/useSession', () => ({
  useSession: () => ({ client: {}, user: { id: 'admin-test' } }),
}));

vi.mock('../../features/request-history/api', () => ({
  adminRequestListQueryOptions: () => ({
    queryKey: ['request-date-url-test'],
    initialPageParam: null,
    queryFn: async () => ({ items: [], snapshotAt: 0, nextCursor: null }),
    getNextPageParam: () => undefined,
  }),
}));

vi.mock('../../features/admin-audit/api', () => ({
  auditQueryOptions: () => ({
    queryKey: ['audit-date-url-test'],
    initialPageParam: null,
    queryFn: async () => ({ items: [], nextCursor: null }),
    getNextPageParam: () => undefined,
  }),
}));

const initialFrom = 1_700_000_000_000;
const initialTo = 1_700_000_000_123;
const nextFrom = 1_700_000_100_000;
const nextTo = 1_700_000_100_789;
const clients: QueryClient[] = [];

function LocationControls({ nextUrl }: { readonly nextUrl: string }) {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="location-search">{location.search}</output>
      <button type="button" data-testid="change-location" onClick={() => navigate(nextUrl)}>
        change location
      </button>
      <button type="button" data-testid="history-back" onClick={() => navigate(-1)}>
        back
      </button>
    </>
  );
}

function renderPage(page: ReactNode, path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  const initialSearch = new URLSearchParams({ from: String(initialFrom), to: String(initialTo) });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`${path}?${initialSearch.toString()}`]}>
        {page}
        <LocationControls
          nextUrl={`${path}?from=${nextFrom}&to=${nextTo}&action=navigated&model=navigated`}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function locationParams() {
  return new URLSearchParams(screen.getByTestId('location-search').textContent ?? '');
}

function dateInput(container: HTMLElement, name: 'from' | 'to'): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(`input[name="${name}"]`);
  if (!input) throw new Error(`Missing ${name} date input.`);
  return input;
}

function dateInputEpoch(container: HTMLElement, name: 'from' | 'to'): number | undefined {
  return parseLocalDateTime(dateInput(container, name).value);
}

async function assertFilterKeepsDateRange(container: HTMLElement, filterName: 'model' | 'action') {
  const filter = container.querySelector<HTMLInputElement>(`input[name="${filterName}"]`);
  if (!filter) throw new Error(`Missing ${filterName} filter input.`);
  fireEvent.change(filter, { target: { value: 'changed-filter' } });
  const form = filter.closest('form');
  if (!form) throw new Error('Missing date filter form.');
  fireEvent.submit(form);

  await waitFor(() => expect(locationParams().get(filterName)).toBe('changed-filter'));
  expect(locationParams().get('from')).toBe(String(initialFrom));
  expect(locationParams().get('to')).toBe(String(initialTo));
}

async function assertLocationUpdatesDates(container: HTMLElement) {
  fireEvent.click(screen.getByTestId('change-location'));
  await waitFor(() => {
    expect(locationParams().get('from')).toBe(String(nextFrom));
    expect(locationParams().get('to')).toBe(String(nextTo));
  });
  expect(dateInputEpoch(container, 'from')).toBe(nextFrom);
  expect(dateInputEpoch(container, 'to')).toBe(nextTo);

  fireEvent.click(screen.getByTestId('history-back'));
  await waitFor(() => {
    expect(locationParams().get('from')).toBe(String(initialFrom));
    expect(locationParams().get('to')).toBe(String(initialTo));
  });
  expect(dateInputEpoch(container, 'from')).toBe(initialFrom);
  expect(dateInputEpoch(container, 'to')).toBe(initialTo);
}

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
});

describe('admin date filter URL behavior', () => {
  it('preserves exact request date bounds when another filter changes and follows location history', async () => {
    const view = renderPage(<RequestsPage />, '/admin/requests');
    expect(dateInputEpoch(view.container, 'from')).toBe(initialFrom);
    expect(dateInputEpoch(view.container, 'to')).toBe(initialTo);

    await assertFilterKeepsDateRange(view.container, 'model');
    await assertLocationUpdatesDates(view.container);
  });

  it('preserves exact audit date bounds when another filter changes and follows location history', async () => {
    const view = renderPage(<AuditPage />, '/admin/audit');
    expect(dateInputEpoch(view.container, 'from')).toBe(initialFrom);
    expect(dateInputEpoch(view.container, 'to')).toBe(initialTo);

    await assertFilterKeepsDateRange(view.container, 'action');
    await assertLocationUpdatesDates(view.container);
  });
});
