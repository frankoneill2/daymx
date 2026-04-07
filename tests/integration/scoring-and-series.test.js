const { __test } = require('../../src/app.js');

describe('scoring and series progression', () => {
  beforeEach(() => {
    __test.resetGamificationState();
  });

  it('awards task-completion points only on incomplete -> complete transitions', () => {
    const when = new Date(2026, 1, 7, 12, 0, 0);
    const task = {
      duration: 5,
      completed: false,
      recurrence: 'none',
      completedAt: null,
      archivedAt: null,
      nextRecurringAt: null,
    };

    __test.setTaskCompleted(task, true, when);
    expect(__test.gamificationSummary(when).points).toBe(10);

    __test.setTaskCompleted(task, true, when);
    expect(__test.gamificationSummary(when).points).toBe(10);

    __test.setTaskCompleted(task, false, when);
    __test.setTaskCompleted(task, true, when);
    expect(__test.gamificationSummary(when).points).toBe(20);
  });

  it('keeps series task completion manual even after all active subtasks are done', () => {
    const when = new Date(2026, 1, 7, 12, 0, 0);
    const task = {
      duration: 15,
      completed: false,
      recurrence: 'none',
      completedAt: null,
      archivedAt: null,
      nextRecurringAt: null,
      series: [
        { id: 's1', text: 'Step 1', rank: 1, order: 0, completed: false, completedAt: null, archivedAt: null },
        { id: 's2', text: 'Step 2', rank: 2, order: 1, completed: false, completedAt: null, archivedAt: null },
      ],
    };

    __test.setSubtaskCompleted(task, task.series[0], true, when);
    expect(task.completed).toBe(false);
    expect(__test.gamificationSummary(when).points).toBe(0);

    __test.setSubtaskCompleted(task, task.series[1], true, when);
    expect(task.completed).toBe(false);
    expect(__test.gamificationSummary(when).points).toBe(0);

    __test.setTaskCompleted(task, true, when);
    expect(task.completed).toBe(true);
    expect(__test.gamificationSummary(when).points).toBe(25);
  });

  it('computes streak from days that reach the daily goal', () => {
    __test.setGamificationDayPoints('2026-02-05', 100);
    __test.setGamificationDayPoints('2026-02-06', 100);
    __test.setGamificationDayPoints('2026-02-07', 100);
    expect(__test.gamificationSummary(new Date(2026, 1, 7, 12, 0, 0)).streak).toBe(3);

    __test.setGamificationDayPoints('2026-02-07', 50);
    expect(__test.gamificationSummary(new Date(2026, 1, 7, 12, 0, 0)).streak).toBe(2);
  });
});
