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
});
