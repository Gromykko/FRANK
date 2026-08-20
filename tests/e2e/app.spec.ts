import { expect, test } from 'playwright/test';
import { FIXTURE_NOW_ISO, mockForecastWorker } from './forecastFixture';

test.beforeEach(async ({ page }) => {
  // Each Playwright test already receives a fresh isolated context. Freezing
  // page time keeps "now", cache-age copy, and planner rows deterministic while
  // still allowing timers and the refresh spinner to advance normally.
  await page.clock.setFixedTime(new Date(FIXTURE_NOW_ISO));
});

test('critical controls work in the production bundle', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium');
  const mock = await mockForecastWorker(page);
  const runtimeErrors: string[] = [];
  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') runtimeErrors.push(message.text());
  });

  await page.goto('./');

  await expect(page.getByRole('heading', { name: /FRANK — Fjord Risk Assessment/ })).toBeVisible();
  await expect(page.locator('.location-switcher-btn')).toContainText('Horsens');
  await expect(page.getByRole('button', { name: 'Opdater prognosen' })).toBeVisible();

  await page.getByRole('button', { name: 'Skift til engelsk' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('button', { name: 'Refresh forecast' })).toBeVisible();

  const refreshButton = page.getByRole('button', { name: 'Refresh forecast' });
  await expect(refreshButton).toHaveAttribute('aria-disabled', 'false');
  const refreshesBeforeClick = mock.requests.filter((url) => url.searchParams.get('refresh') === '1').length;
  await refreshButton.click();
  await expect.poll(
    () => mock.requests.filter((url) => url.searchParams.get('refresh') === '1').length,
  ).toBe(refreshesBeforeClick + 1);
  await expect(refreshButton).toBeFocused();

  const calendarButton = page.getByRole('button', { name: 'Calendar' });
  await calendarButton.click();
  await expect(calendarButton).toHaveAttribute('aria-pressed', 'true');
  const calendar = page.getByRole('list', { name: /Launch windows by day/ });
  await expect(calendar).toBeVisible();
  await calendar.getByRole('button').first().click();
  await expect(page.locator('.calendar-view').getByRole('status')).toContainText('Selected window');

  const manualButton = page.getByRole('button', { name: 'How FRANK Decides' });
  await manualButton.click();
  const dialog = page.getByRole('dialog', { name: 'HOW FRANK DECIDES' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(manualButton).toBeFocused();

  expect(runtimeErrors).toEqual([]);
});

test('language and location choices survive their reload paths', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium');
  const mock = await mockForecastWorker(page);

  await page.goto('./');
  await expect(page.locator('.app-footer')).toBeVisible();

  await page.getByRole('button', { name: 'Skift til engelsk' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('button', { name: 'Refresh forecast' })).toBeVisible();

  await page.locator('.location-switcher-btn').click();
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
    page.getByRole('menuitem', { name: 'Vejle Fjord' }).click(),
  ]);
  await expect(page.locator('.location-switcher-btn')).toContainText('Vejle');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect.poll(() => mock.requests.some((url) => url.pathname.endsWith('/forecast/vejle'))).toBe(true);

  await page.reload();
  await expect(page.locator('.location-switcher-btn')).toContainText('Vejle');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});

test('the complete dashboard stays inside every supported viewport', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'service-worker-chromium');
  await mockForecastWorker(page);
  await page.goto('./');
  await expect(page.locator('.app-footer')).toBeVisible();
  await page.evaluate(async () => { await document.fonts.ready; });

  const headerTargets = await page.locator('.header-icon-btn').evaluateAll((buttons) => (
    buttons.map((button) => {
      const { width, height } = button.getBoundingClientRect();
      return { width, height };
    })
  ));
  expect(headerTargets.length).toBeGreaterThan(0);
  for (const target of headerTargets) {
    expect(target.width).toBeGreaterThanOrEqual(44);
    expect(target.height).toBeGreaterThanOrEqual(44);
  }

  const overflowPx = await page.evaluate(() => (
    Math.max(document.body.scrollWidth, document.documentElement.scrollWidth)
      - document.documentElement.clientWidth
  ));
  expect(overflowPx).toBeLessThanOrEqual(1);
});

test('an installed production shell reloads with the saved forecast offline', async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== 'service-worker-chromium');
  const mock = await mockForecastWorker(page);

  await page.goto('./');
  await expect(page.locator('.app-footer')).toBeVisible();
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });

  await expect.poll(() => page.evaluate(() => (
    Object.keys(localStorage).some((key) => key.startsWith('frank_weather_data_v2_'))
  ))).toBe(true);

  // The first load is not controlled, so its forecast request is intercepted.
  // Remove that route and go offline BEFORE the navigation that first becomes
  // controlled. Playwright cannot intercept traffic once a service worker owns
  // it; this order proves no controlled online request can escape to production.
  await mock.stop();

  await context.setOffline(true);
  try {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: /FRANK — Fjord Risk Assessment/ })).toBeVisible();
    await expect(page.locator('.location-switcher-btn')).toContainText('Horsens');
    await expect(page.locator('.snapshot').getByText('18.0°C', { exact: true })).toBeVisible();
    await expect(page.locator('.app-footer')).toBeVisible();
    expect(await page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  } finally {
    await context.setOffline(false);
  }
});
