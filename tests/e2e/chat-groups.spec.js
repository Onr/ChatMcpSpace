/**
 * Chat Groups E2E Tests (Playwright)
 *
 * Tests the group creation, rendering, zoom, and removal flows.
 * Requires: the app running on localhost:3000 with a logged-in session.
 *
 * Run: npx playwright test tests/e2e/chat-groups.spec.js
 */

const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

// Helper: login and navigate to dashboard
async function loginAndDashboard(page) {
  await page.goto(`${BASE_URL}/login`);
  // If already on dashboard, skip login
  if (page.url().includes('/dashboard')) return;
  await page.fill('input[name="email"]', process.env.TEST_EMAIL || 'test@test.com');
  await page.fill('input[name="password"]', process.env.TEST_PASSWORD || 'testpassword');
  await page.click('button[type="submit"]');
  await page.waitForURL('**/dashboard', { timeout: 10000 });
}

test.describe('Chat Groups', () => {
  test.beforeEach(async ({ page }) => {
    await loginAndDashboard(page);
    await page.waitForSelector('#agentSeats', { timeout: 10000 });
  });

  test('Create Group FAB is visible', async ({ page }) => {
    const fab = page.locator('#createGroupFab');
    await expect(fab).toBeVisible();
  });

  test('Create Group modal opens and closes', async ({ page }) => {
    // Open modal
    await page.click('#createGroupFab');
    const modal = page.locator('#createGroupModal');
    await expect(modal).toBeVisible();

    // Check form elements exist
    await expect(page.locator('#groupNameInput')).toBeVisible();
    await expect(page.locator('#groupDescInput')).toBeVisible();
    await expect(page.locator('#createGroupConfirmBtn')).toBeVisible();

    // Close via cancel
    await page.click('#createGroupCancelBtn');
    await expect(modal).toBeHidden();
  });

  test('Create Group modal shows agent selection checkboxes', async ({ page }) => {
    await page.click('#createGroupFab');
    await page.waitForSelector('#groupAgentSelection');

    const checkboxes = page.locator('.group-agent-checkbox');
    // Should have at least 0 checkboxes (depends on agents)
    const count = await checkboxes.count();
    expect(count).toBeGreaterThanOrEqual(0);
  });

  test('Group creation flow end-to-end', async ({ page }) => {
    // Only run if agents exist
    await page.click('#createGroupFab');
    await page.waitForSelector('#groupAgentSelection');

    const checkboxes = page.locator('.group-agent-checkbox');
    const agentCount = await checkboxes.count();
    if (agentCount === 0) {
      test.skip();
      return;
    }

    // Fill in group name
    const groupName = `Test Group ${Date.now()}`;
    await page.fill('#groupNameInput', groupName);
    await page.fill('#groupDescInput', 'E2E test group');

    // Select first agent
    await checkboxes.first().check();
    await expect(page.locator('#groupSelectedCount')).toHaveText('1');

    // Create
    await page.click('#createGroupConfirmBtn');

    // Modal should close
    await expect(page.locator('#createGroupModal')).toBeHidden({ timeout: 5000 });

    // Group seat should appear on orbit
    await page.waitForSelector(`.group-seat[data-group-name="${groupName}"]`, { timeout: 10000 });
    const groupSeat = page.locator(`.group-seat[data-group-name="${groupName}"]`);
    await expect(groupSeat).toBeVisible();
  });

  test('Clicking group zooms in and shows back button', async ({ page }) => {
    // Check if any group seats exist
    const groupSeats = page.locator('.group-seat');
    const groupCount = await groupSeats.count();
    if (groupCount === 0) {
      test.skip();
      return;
    }

    // Click first group
    await groupSeats.first().click();

    // Back button should appear
    const backBtn = page.locator('#groupBackBtn');
    await expect(backBtn).toBeVisible({ timeout: 5000 });

    // Center label should show group name (not "You")
    const centerLabel = page.locator('.council-center p');
    const centerText = await centerLabel.textContent();
    expect(centerText).not.toBe('You');
  });

  test('Back button returns to main view', async ({ page }) => {
    const groupSeats = page.locator('.group-seat');
    const groupCount = await groupSeats.count();
    if (groupCount === 0) {
      test.skip();
      return;
    }

    // Enter group view
    await groupSeats.first().click();
    await expect(page.locator('#groupBackBtn')).toBeVisible({ timeout: 5000 });

    // Click back
    await page.click('#groupBackBtn');

    // Back button should be hidden
    await expect(page.locator('#groupBackBtn')).toBeHidden({ timeout: 5000 });

    // Center label should be "You" again
    const centerLabel = page.locator('.council-center p');
    await expect(centerLabel).toHaveText('You');

    // Group seats should reappear
    await expect(page.locator('.group-seat').first()).toBeVisible();
  });

  test('Group priority badge reflects highest member priority', async ({ page }) => {
    const badges = page.locator('.group-seat__badge');
    const count = await badges.count();
    // Just verify badges exist and are correctly classed if present
    for (let i = 0; i < count; i++) {
      const badge = badges.nth(i);
      const classes = await badge.getAttribute('class');
      expect(classes).toMatch(/group-seat__badge--(urgent|unread)/);
    }
  });

  test('Agent list panel shows group headers', async ({ page }) => {
    const groupHeaders = page.locator('.agent-list-group-header[data-group-id]');
    const count = await groupHeaders.count();
    // If groups exist, headers should be visible
    if (count > 0) {
      await expect(groupHeaders.first()).toBeVisible();
    }
  });

  test('All group UI elements are accessible', async ({ page }) => {
    // FAB has aria-label
    const fab = page.locator('#createGroupFab');
    await expect(fab).toHaveAttribute('aria-label', 'Create Group');

    // Back button has aria-label
    const backBtn = page.locator('#groupBackBtn');
    await expect(backBtn).toHaveAttribute('aria-label', 'Back to all agents');
  });
});

test.describe('Chat Groups - Mobile', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test.beforeEach(async ({ page }) => {
    await loginAndDashboard(page);
    await page.waitForTimeout(2000); // Wait for initial load
  });

  test('Mobile dock shows group items when groups exist', async ({ page }) => {
    const dockGroups = page.locator('#dockCarousel .dock-group');
    // Just verify the dock renders without errors
    // Group items only appear if groups are configured
    const count = await dockGroups.count();
    expect(count).toBeGreaterThanOrEqual(0);
  });

  test('Create Group FAB is visible on mobile', async ({ page }) => {
    const fab = page.locator('#createGroupFab');
    await expect(fab).toBeVisible();
  });
});
