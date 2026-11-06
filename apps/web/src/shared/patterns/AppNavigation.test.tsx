import { expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { PersonalNavigation } from './AppNavigation';
import { NavigationProvider } from './NavigationState';
import { useNavigationSheet } from './useNavigationSheet';
import { RouteButton } from '../ui/RouteButton';

function Fixture() {
  const location = useLocation();
  const [open, setOpen] = useNavigationSheet();
  return (
    <>
      <PersonalNavigation />
      <output>{location.pathname}</output>
      <button onClick={() => setOpen(true)}>打开菜单</button>
      <div data-testid="drawer">{open ? 'open' : 'closed'}</div>
      <RouteButton to={`${location.pathname}?period=month`}>更新筛选</RouteButton>
      <RouteButton to="/keys" disabled>
        不可用入口
      </RouteButton>
    </>
  );
}

it('clears account-specific navigation without remounting the router', async () => {
  const user = userEvent.setup();
  const view = (scope: string) => (
    <NavigationProvider scope={scope}>
      <MemoryRouter initialEntries={['/chat/private']}>
        <Fixture />
      </MemoryRouter>
    </NavigationProvider>
  );
  const { rerender } = render(view('account-a'));
  await user.click(screen.getByRole('button', { name: '生图' }));
  rerender(view('account-b'));
  expect(screen.getByRole('status')).toHaveTextContent('/images');
  await user.click(screen.getByRole('button', { name: '对话' }));
  expect(screen.getByRole('status').textContent).toBe('/chat');
});

it('uses one set of button menus and restores the selected conversation after visiting other pages', async () => {
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={['/chat/existing']}>
      <NavigationProvider>
        <Fixture />
      </NavigationProvider>
    </MemoryRouter>,
  );
  const navigation = within(screen.getByRole('navigation', { name: '个人导航' }));
  expect(navigation.queryAllByRole('link')).toHaveLength(0);
  expect(navigation.getAllByRole('button').map((button) => button.textContent)).toEqual([
    '对话',
    '生图',
    '模型目录',
    'API 接入',
    '费用',
    '使用记录',
  ]);
  await user.click(screen.getByRole('button', { name: '打开菜单' }));
  await user.click(navigation.getByRole('button', { name: '模型目录' }));
  expect(screen.getByRole('status')).toHaveTextContent('/console/models');
  expect(screen.getByTestId('drawer')).toHaveTextContent('closed');
  expect(navigation.getByRole('button', { name: '模型目录' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await user.click(navigation.getByRole('button', { name: '对话' }));
  expect(screen.getByRole('status')).toHaveTextContent('/chat/existing');
  await user.click(screen.getByRole('button', { name: '不可用入口' }));
  expect(screen.getByRole('status')).toHaveTextContent('/chat/existing');
});

it('keeps navigation open when the current page normalizes its query', async () => {
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={['/billing']}>
      <NavigationProvider>
        <Fixture />
      </NavigationProvider>
    </MemoryRouter>,
  );
  await user.click(screen.getByRole('button', { name: '打开菜单' }));
  await user.click(screen.getByRole('button', { name: '更新筛选' }));
  expect(screen.getByTestId('drawer')).toHaveTextContent('open');
  await user.click(screen.getByRole('button', { name: 'API 接入' }));
  expect(screen.getByTestId('drawer')).toHaveTextContent('closed');
});
