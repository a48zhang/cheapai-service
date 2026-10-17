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
  const picker = page.getByRole('button', { name: '外观', exact: true });
  await picker.click();
  await page.getByRole('menuitemradio', { name: '深色', exact: true }).click();
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await picker.click();
  await expect(page.getByRole('menuitemradio', { name: '深色', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await page.keyboard.press('Escape');
  await expect(picker).toBeFocused();
  const other = await context.newPage();
  await anonymous(other);
  await other.goto('/chat');
  await expect(other.locator('html')).toHaveAttribute('data-theme', 'dark');
  await picker.click();
  await page.getByRole('menuitemradio', { name: '浅色', exact: true }).click();
  await expect(other.locator('html')).toHaveAttribute('data-theme', 'light');
  await other.evaluate(() => localStorage.removeItem('cheapai.appearance.v1'));
  await picker.click();
  await expect(page.getByRole('menuitemradio', { name: '跟随系统', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await page.keyboard.press('Escape');
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
  await page.getByRole('button', { name: '外观', exact: true }).click();
  await page.getByRole('menuitemradio', { name: '深色', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('appearance menu supports keyboard navigation and outside dismissal', async ({ page }) => {
  await anonymous(page);
  await page.goto('/');
  const picker = page.getByRole('button', { name: '外观', exact: true });
  await picker.focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitemradio', { name: '浅色', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitemradio', { name: '深色', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(picker).toBeFocused();
  await picker.click();
  await page.keyboard.press('End');
  await expect(page.getByRole('menuitemradio', { name: '跟随系统', exact: true })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(page.getByRole('menuitemradio', { name: '浅色', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu', { name: '外观', exact: true })).toHaveCount(0);
  await expect(picker).toBeFocused();
  await picker.click();
  await page.locator('main').click({ position: { x: 10, y: 10 } });
  await expect(picker).toHaveAttribute('aria-expanded', 'false');
});
