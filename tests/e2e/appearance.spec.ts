import { expect, test, type Page } from '@playwright/test';

async function anonymous(page: Page) {
  await page.route('**/api/v1/**', (route) =>
    route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }),
  );
}

test('appearance follows the OS, persists overrides, and synchronizes tabs', async ({
  page,
  context,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await anonymous(page);
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  const picker = page.getByRole('combobox', { name: '外观', exact: true });
  await picker.selectOption('dark');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(picker).toHaveValue('dark');
  const other = await context.newPage();
  await anonymous(other);
  await other.goto('/chat');
  await expect(other.locator('html')).toHaveAttribute('data-theme', 'dark');
  await picker.selectOption('light');
  await expect(other.locator('html')).toHaveAttribute('data-theme', 'light');
  await other.evaluate(() => localStorage.removeItem('cheapai.appearance.v1'));
  await expect(picker).toHaveValue('system');
  await other.close();
});

test('dark appearance initializes before the application bundle is allowed to load', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.addInitScript(() => localStorage.setItem('cheapai.appearance.v1', 'dark'));
  await page.route('**/assets/*.js', (route) => route.abort());
  await page.goto('/chat', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark');
});

test('storage failure does not prevent switching appearance', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get() {
        throw new Error('Storage blocked');
      },
    });
  });
  await anonymous(page);
  await page.goto('/');
  await page.getByRole('combobox', { name: '外观', exact: true }).selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('status').filter({ hasText: '外观已切换' })).toContainText(
    '暂时无法保存',
  );
});
