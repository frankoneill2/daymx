const { test, expect } = require('@playwright/test');

test.describe('daymx critical flows', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/src/firebase-init.js*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/javascript',
        body: '',
      });
    });
  });

  test('keeps review progress when navigating away and back', async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('daymx-unlocked', '1');
      window.sessionStorage.setItem('daymx-unlocked', '1');
      window.localStorage.setItem('daymx-data-v1', JSON.stringify({
        threads: [
          { id: 'n1', name: 'Thread A', enabled: true, collapsed: false, children: [], questions: [], tasks: [] },
          { id: 'n2', name: 'Thread B', enabled: true, collapsed: false, children: [], questions: [], tasks: [] },
        ],
        pantry: { categories: [] },
      }));
    });

    await page.goto('/');
    await page.getByRole('tab', { name: 'Review' }).click();
    await page.getByRole('button', { name: 'Start Review' }).click();

    await page.getByRole('button', { name: 'Next' }).click();
    const titleBefore = await page.locator('#story-card .story-title').innerText();

    await page.getByRole('tab', { name: 'Tasks' }).click();
    await page.getByRole('tab', { name: 'Review' }).click();

    await expect(page.locator('#review-stage')).toBeVisible();
    await expect(page.locator('#story-card .story-title')).toHaveText(titleBefore);
  });

  test('filters tasks by P1 only in tasks pane', async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('daymx-unlocked', '1');
      window.sessionStorage.setItem('daymx-unlocked', '1');
      window.localStorage.setItem('daymx-data-v1', JSON.stringify({
        threads: [
          {
            id: 'n1',
            name: 'Work',
            enabled: true,
            collapsed: false,
            children: [],
            questions: [],
            tasks: [
              { id: 't1', text: 'P1 task', priority: 1, completed: false, locations: [], contexts: [], blockedBy: [], waitingOn: '', recurrence: 'none', duration: 5, series: [] },
              { id: 't2', text: 'P3 task', priority: 3, completed: false, locations: [], contexts: [], blockedBy: [], waitingOn: '', recurrence: 'none', duration: 5, series: [] },
            ],
          },
        ],
        pantry: { categories: [] },
      }));
      window.localStorage.removeItem('daymx-tasks-view-v2');
    });

    await page.goto('/');
    await page.getByRole('tab', { name: 'Tasks' }).click();

    await expect(page.locator('#tasks-root input.task-title-input[value="P1 task"]')).toHaveCount(1);
    await expect(page.locator('#tasks-root input.task-title-input[value="P3 task"]')).toHaveCount(1);

    const priorityGroup = page.locator('#tasks-controls .filter-group').filter({ hasText: 'Priority' });
    await priorityGroup.getByRole('button', { name: 'P1' }).click();

    await expect(page.locator('#tasks-root input.task-title-input[value="P1 task"]')).toHaveCount(1);
    await expect(page.locator('#tasks-root input.task-title-input[value="P3 task"]')).toHaveCount(0);
  });

  test('reveals the next series step immediately after completing the current one', async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('daymx-unlocked', '1');
      window.sessionStorage.setItem('daymx-unlocked', '1');
      window.localStorage.setItem('daymx-data-v1', JSON.stringify({
        threads: [
          {
            id: 'n1',
            name: 'Home',
            enabled: true,
            collapsed: false,
            children: [],
            questions: [],
            tasks: [
              {
                id: 't1',
                text: 'Cook curry',
                priority: 2,
                completed: false,
                locations: [],
                contexts: [],
                blockedBy: [],
                waitingOn: '',
                recurrence: 'none',
                duration: 15,
                series: [
                  { id: 's1', text: 'Shop for ingredients', rank: 1, order: 0, completed: false },
                  { id: 's2', text: 'Unpack the car', rank: 2, order: 1, completed: false },
                ],
              },
            ],
          },
        ],
        pantry: { categories: [] },
      }));
      window.localStorage.removeItem('daymx-tasks-view-v2');
    });

    await page.goto('/');
    await page.getByRole('tab', { name: 'Tasks' }).click();

    await expect(page.locator('#tasks-root input.task-title-input[value="Shop for ingredients"]')).toHaveCount(1);
    await expect(page.locator('#tasks-root input.task-title-input[value="Unpack the car"]')).toHaveCount(0);

    const stepOneCard = page.locator('#tasks-root .task').filter({
      has: page.locator('input.task-title-input[value="Shop for ingredients"]'),
    }).first();
    await stepOneCard.locator('input[type="checkbox"]').first().check();

    await expect(page.locator('#tasks-root input.task-title-input[value="Unpack the car"]')).toHaveCount(1);
    await expect(page.locator('#toast')).toContainText('Next step unlocked');
  });

  test('resets stale daily review state and shows today date header', async ({ page }) => {
    await page.addInitScript(() => {
      const now = new Date();
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const key = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
      window.localStorage.setItem('daymx-unlocked', '1');
      window.sessionStorage.setItem('daymx-unlocked', '1');
      window.localStorage.setItem('daymx-data-v1', JSON.stringify({
        threads: [
          { id: 'n1', name: 'Thread A', enabled: true, collapsed: false, children: [], questions: [], tasks: [] },
          { id: 'n2', name: 'Thread B', enabled: true, collapsed: false, children: [], questions: [], tasks: [] },
        ],
        pantry: { categories: [] },
        dailyReview: { dayKey: key, active: true, idx: 1, currentId: 'n2' },
      }));
      window.__todayReviewLabel = new Date().toLocaleDateString(undefined, {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
    });

    await page.goto('/');
    await page.getByRole('tab', { name: 'Review' }).click();

    await expect(page.locator('#btn-start-review')).toBeVisible();
    await expect(page.locator('#review-stage')).toBeHidden();
    await expect(page.locator('#review-date')).toHaveText(await page.evaluate(() => window.__todayReviewLabel));
  });

  test('allows jumping through review stories by clicking the progress bar', async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('daymx-unlocked', '1');
      window.sessionStorage.setItem('daymx-unlocked', '1');
      window.localStorage.setItem('daymx-data-v1', JSON.stringify({
        threads: [
          { id: 'n1', name: 'Alpha', enabled: true, collapsed: false, children: [], questions: [], tasks: [] },
          { id: 'n2', name: 'Bravo', enabled: true, collapsed: false, children: [], questions: [], tasks: [] },
          { id: 'n3', name: 'Charlie', enabled: true, collapsed: false, children: [], questions: [], tasks: [] },
        ],
        pantry: { categories: [] },
      }));
    });

    await page.goto('/');
    await page.getByRole('tab', { name: 'Review' }).click();
    await page.getByRole('button', { name: 'Start Review' }).click();

    await page.locator('#story-progress .segment').nth(2).click();
    await expect(page.locator('#story-card .story-title')).toHaveText('Charlie');
  });

  test('captures task priority/tag and keeps jump link until refresh', async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('daymx-unlocked', '1');
      window.sessionStorage.setItem('daymx-unlocked', '1');
      window.localStorage.setItem('daymx-data-v1', JSON.stringify({
        threads: [
          { id: 'n1', name: 'Inbox', enabled: true, collapsed: false, children: [], questions: [], tasks: [] },
        ],
        pantry: { categories: [] },
      }));
    });

    await page.goto('/');
    await page.fill('#quick-capture-input', 'Call landlord');
    await page.selectOption('#quick-capture-priority', '1');
    await page.selectOption('#quick-capture-tag', 'home');
    await page.click('#quick-capture-form button[type="submit"]');

    const payload = await page.evaluate(() => JSON.parse(window.localStorage.getItem('daymx-data-v1')));
    expect(payload.threads[0].tasks[0].priority).toBe(1);
    expect(payload.threads[0].tasks[0].locations).toEqual(['home']);

    await expect(page.locator('#quick-capture-link')).toContainText('Call landlord');
    await page.locator('#quick-capture-link .capture-jump').click();
    await expect(page.locator('.inline-item[data-task-id] input.task-title-input[value="Call landlord"]')).toHaveCount(1);

    await page.getByRole('tab', { name: 'Tasks' }).click();
    await page.getByRole('tab', { name: 'Prepare' }).click();
    await expect(page.locator('#quick-capture-link')).toContainText('Call landlord');

    await page.reload();
    await expect(page.locator('#quick-capture-link')).toBeHidden();
  });

  test('shows moving label when rethreading tasks and clears it after navigation', async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('daymx-unlocked', '1');
      window.sessionStorage.setItem('daymx-unlocked', '1');
      window.localStorage.setItem('daymx-data-v1', JSON.stringify({
        threads: [
          {
            id: 'n1',
            name: 'Thread A',
            enabled: true,
            collapsed: false,
            children: [],
            questions: [],
            tasks: [{ id: 't1', text: 'Move me', priority: 3, completed: false, locations: [], contexts: [], blockedBy: [], waitingOn: '', recurrence: 'none', duration: null, series: [] }],
          },
          {
            id: 'n2',
            name: 'Thread B',
            enabled: true,
            collapsed: false,
            children: [],
            questions: [],
            tasks: [],
          },
        ],
        pantry: { categories: [] },
      }));
    });

    await page.goto('/');
    await page.locator('.inline-item[data-task-id="t1"] .task-thread-select').selectOption('n2');
    await expect(page.locator('.inline-item.moving-task')).toContainText('moving to Thread B...');

    await page.getByRole('tab', { name: 'Tasks' }).click();
    await expect(page.locator('.task-section-moving')).toContainText('moving to Thread B...');

    await page.getByRole('tab', { name: 'Prepare' }).click();
    await expect(page.locator('.inline-item.moving-task')).toHaveCount(0);
  });
});
