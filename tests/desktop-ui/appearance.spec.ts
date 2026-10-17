import { expect, test } from '@playwright/test';

test('Desktop settings switch real DSH code highlighting without remounting messages', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/tests/appearance.html');
  const token = page.locator('pre code span[style]').first();
  await expect(token).toBeVisible();
  const originalToken = await token.elementHandle();
  const lightColor = await token.evaluate((element) => getComputedStyle(element).color);
  await page.getByRole('button', { name: '外观', exact: true }).click();
  await page.getByRole('menuitemradio', { name: '深色', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await originalToken!.evaluate((element) => element.isConnected)).toBe(true);
  expect(await token.evaluate((element) => getComputedStyle(element).color)).not.toBe(lightColor);
});

test('Desktop synchronizes native chrome and resets it to system mode', async ({ page }) => {
  await page.addInitScript(() => {
    const target = window as unknown as {
      __TAURI_INTERNALS__: unknown;
      themeCalls: unknown[];
      isTauri: boolean;
    };
    target.isTauri = true;
    target.themeCalls = [];
    target.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      invoke: async (command: string, args: unknown) => {
        if (command === 'plugin:window|set_theme') target.themeCalls.push(args);
      },
    };
  });
  await page.goto('/tests/appearance.html');
  await page.getByRole('button', { name: '外观', exact: true }).click();
  await page.getByRole('menuitemradio', { name: '深色', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { themeCalls: { value: string | null }[] }).themeCalls.at(-1)
            ?.value,
      ),
    )
    .toBe('dark');
  await page.getByRole('button', { name: '外观', exact: true }).click();
  await page.getByRole('menuitemradio', { name: '跟随系统', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { themeCalls: { value: string | null }[] }).themeCalls.at(-1)
            ?.value,
      ),
    )
    .toBe(null);
});
