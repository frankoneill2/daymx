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

  test('opens on Tasks by default', async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('daymx-unlocked', '1');
      window.sessionStorage.setItem('daymx-unlocked', '1');
      window.localStorage.setItem('daymx-data-v1', JSON.stringify({
        threads: [
          { id: 'n1', name: 'Thread A', enabled: true, collapsed: false, children: [], questions: [], tasks: [] },
        ],
        pantry: { categories: [] },
      }));
    });

    await page.goto('/');

    await expect(page.locator('#view-tasks')).toBeVisible();
    await expect(page.locator('#view-prepare')).toBeHidden();
    await expect(page.locator('#tab-tasks')).toHaveClass(/active/);
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

    const beforeTitles = await page.locator('#tasks-root .task .task-title-input').evaluateAll((els) => els.map((el) => el.value));
    expect(beforeTitles).toContain('P1 task');
    expect(beforeTitles).toContain('P3 task');

    await page.locator('.tasks-more-filters summary').click();
    const priorityGroup = page.locator('.tasks-more-filters .filter-group').filter({ hasText: 'Priority' });
    await priorityGroup.getByRole('button', { name: 'P1' }).click();

    const afterTitles = await page.locator('#tasks-root .task .task-title-input').evaluateAll((els) => els.map((el) => el.value));
    expect(afterTitles).toContain('P1 task');
    expect(afterTitles).not.toContain('P3 task');
  });

  test('filters tasks by selected thread scope', async ({ page }) => {
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
            questions: [],
            tasks: [
              { id: 't1', text: 'Work root task', priority: 2, completed: false, locations: [], contexts: [], blockedBy: [], waitingOn: '', recurrence: 'none', duration: 5, series: [] },
            ],
            children: [
              {
                id: 'n1a',
                name: 'Project X',
                enabled: true,
                collapsed: false,
                questions: [],
                tasks: [
                  { id: 't2', text: 'Work child task', priority: 3, completed: false, locations: [], contexts: [], blockedBy: [], waitingOn: '', recurrence: 'none', duration: 5, series: [] },
                ],
                children: [],
              },
            ],
          },
          {
            id: 'n2',
            name: 'Home',
            enabled: true,
            collapsed: false,
            questions: [],
            tasks: [
              { id: 't3', text: 'Home task', priority: 2, completed: false, locations: [], contexts: [], blockedBy: [], waitingOn: '', recurrence: 'none', duration: 5, series: [] },
            ],
            children: [],
          },
        ],
        pantry: { categories: [] },
      }));
      window.localStorage.removeItem('daymx-tasks-view-v2');
    });

    await page.goto('/');
    await page.getByRole('tab', { name: 'Tasks' }).click();

    await page.locator('.tasks-more-filters summary').click();
    await page.locator('.task-thread-filter-select').selectOption('n1');

    const titles = await page.locator('#tasks-root .task .task-title-input').evaluateAll((els) => els.map((el) => el.value));
    expect(titles).toContain('Work root task');
    expect(titles).toContain('Work child task');
    expect(titles).not.toContain('Home task');
  });

  test('moves task to a different thread from task card', async ({ page }) => {
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
            tasks: [{ id: 't1', text: 'Move me from task card', priority: 3, completed: false, locations: [], contexts: [], blockedBy: [], waitingOn: '', recurrence: 'none', duration: 5, series: [] }],
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
      window.localStorage.removeItem('daymx-tasks-view-v2');
    });

    await page.goto('/');
    await page.getByRole('tab', { name: 'Tasks' }).click();
    await page.locator('#tasks-root .task[data-task-id="t1"] .task-thread-select').first().selectOption('n2');

    const payload = await page.evaluate(() => JSON.parse(window.localStorage.getItem('daymx-data-v1')));
    const threadA = payload.threads.find((n) => n.id === 'n1');
    const threadB = payload.threads.find((n) => n.id === 'n2');
    expect(threadA.tasks.some((t) => t.id === 't1')).toBe(false);
    expect(threadB.tasks.some((t) => t.id === 't1')).toBe(true);
  });

  test('shows follow-ups due for blocked tasks even when blocked tasks are hidden', async ({ page }) => {
    await page.addInitScript(() => {
      const now = new Date();
      const overdue = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
      window.localStorage.setItem('daymx-unlocked', '1');
      window.sessionStorage.setItem('daymx-unlocked', '1');
      window.localStorage.setItem('daymx-data-v1', JSON.stringify({
        threads: [
          {
            id: 'n1',
            name: 'Admin',
            enabled: true,
            collapsed: false,
            children: [],
            questions: [],
            tasks: [
              {
                id: 't1',
                text: 'Wait for insurance callback',
                priority: 2,
                completed: false,
                locations: [],
                contexts: [],
                blockedBy: [],
                waitingOn: 'Insurer',
                followUpAt: overdue,
                recurrence: 'none',
                duration: 5,
                series: [],
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

    const followups = page.locator('#tasks-root .task-section-followups');
    await expect(followups).toBeVisible();
    await expect(followups).toContainText('Follow-Ups Due');
    await expect(followups).toContainText('Wait for insurance callback');

    await followups.getByRole('button', { name: 'Nudged today' }).first().click();

    await expect(page.locator('#tasks-root .task-section-followups')).toHaveCount(0);
    await expect(page.locator('#tasks-root .empty')).toContainText('No tasks in the current view.');
  });

  test('tracks daily review streak after completing today review', async ({ page }) => {
    await page.addInitScript(() => {
      const now = new Date();
      const y1 = new Date(now);
      y1.setDate(y1.getDate() - 1);
      const y2 = new Date(now);
      y2.setDate(y2.getDate() - 2);
      const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      window.localStorage.setItem('daymx-unlocked', '1');
      window.sessionStorage.setItem('daymx-unlocked', '1');
      window.localStorage.setItem('daymx-data-v1', JSON.stringify({
        threads: [
          { id: 'n1', name: 'Thread A', enabled: true, collapsed: false, children: [], questions: [], tasks: [] },
        ],
        pantry: { categories: [] },
        dailyReview: {
          dayKey: '',
          active: false,
          idx: 0,
          currentId: null,
          completedDays: {
            [dayKey(y1)]: true,
            [dayKey(y2)]: true,
          },
        },
      }));
    });

    await page.goto('/');
    await page.getByRole('tab', { name: 'Review' }).click();
    await page.getByRole('button', { name: 'Start Review' }).click();
    await page.getByRole('button', { name: 'Next' }).click();

    await expect(page.locator('#review-streak')).toContainText('3 days');
    const completedToday = await page.evaluate(() => {
      const payload = JSON.parse(window.localStorage.getItem('daymx-data-v1'));
      const now = new Date();
      const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      return !!payload?.dailyReview?.completedDays?.[key];
    });
    expect(completedToday).toBe(true);
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

    const projectCard = page.locator('#tasks-root .series-flow-card').first();
    const beforeSteps = await projectCard.locator('.series-next-text').evaluateAll((els) => els.map((el) => el.value));
    expect(beforeSteps).toContain('Shop for ingredients');
    expect(beforeSteps).not.toContain('Unpack the car');

    await projectCard.locator('.series-next-row input[type="checkbox"]').first().click();

    const afterSteps = await projectCard.locator('.series-next-text').evaluateAll((els) => els.map((el) => el.value));
    expect(afterSteps).toContain('Unpack the car');
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
    const prepareTaskTitles = await page.locator('.inline-item[data-task-id] .task-title-input').evaluateAll((els) => els.map((el) => el.value));
    expect(prepareTaskTitles).toContain('Call landlord');

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
    await page.getByRole('tab', { name: 'Prepare' }).click();
    await page.locator('.inline-item[data-task-id="t1"] .task-thread-select').selectOption('n2');
    await expect(page.locator('.inline-item.moving-task')).toContainText('moving to Thread B...');

    await page.getByRole('tab', { name: 'Tasks' }).click();
    const taskTitles = await page.locator('#tasks-root .task .task-title-input').evaluateAll((els) => els.map((el) => el.value));
    expect(taskTitles).toContain('Move me');
    await expect(page.locator('.task-section-moving')).toHaveCount(0);

    await page.getByRole('tab', { name: 'Prepare' }).click();
    await expect(page.locator('.inline-item.moving-task')).toHaveCount(1);
  });
});
