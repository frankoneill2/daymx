const { __test } = require('../../src/app.js');

describe('task breakdown helpers', () => {
  it('moves active predictions to history when a task is marked as needing breakdown', () => {
    const task = {
      id: 't_breakdown',
      text: 'Plan launch',
      needsBreakdown: false,
      breakdownNote: '',
      breakdownFlaggedAt: null,
      prediction: {
        id: 'pred_breakdown',
        probability: 85,
        madeAt: '2026-02-01T09:00:00.000Z',
        resolveBy: '2026-02-02T23:59:00.000Z',
        outcome: 'open',
        madeInRootId: 'root_1',
        madeInRootName: 'Work',
      },
      predictionHistory: [],
    };

    __test.markTaskNeedsBreakdown(task, true, 'Too many moving parts', new Date('2026-02-01T10:00:00.000Z'));

    expect(task.needsBreakdown).toBe(true);
    expect(task.breakdownNote).toBe('Too many moving parts');
    expect(task.breakdownFlaggedAt).toBe('2026-02-01T10:00:00.000Z');
    expect(task.prediction).toBeNull();
    expect(task.predictionHistory).toHaveLength(1);
    expect(task.predictionHistory[0].outcome).toBe('superseded');
  });

  it('uses end-of-day deadlines for quick prediction presets', () => {
    const now = new Date('2026-02-01T09:15:00.000Z');
    const tomorrow = new Date(__test.predictionDeadlinePreset('tomorrow', now));
    const week = new Date(__test.predictionDeadlinePreset('week', now));

    const expectedTomorrow = new Date(now);
    expectedTomorrow.setDate(expectedTomorrow.getDate() + 1);
    const expectedWeek = new Date(now);
    expectedWeek.setDate(expectedWeek.getDate() + 7);

    expect(tomorrow.getHours()).toBe(23);
    expect(tomorrow.getMinutes()).toBe(59);
    expect(tomorrow.getDate()).toBe(expectedTomorrow.getDate());
    expect(tomorrow.getMonth()).toBe(expectedTomorrow.getMonth());
    expect(tomorrow.getFullYear()).toBe(expectedTomorrow.getFullYear());

    expect(week.getHours()).toBe(23);
    expect(week.getMinutes()).toBe(59);
    expect(week.getDate()).toBe(expectedWeek.getDate());
    expect(week.getMonth()).toBe(expectedWeek.getMonth());
    expect(week.getFullYear()).toBe(expectedWeek.getFullYear());
  });
});
