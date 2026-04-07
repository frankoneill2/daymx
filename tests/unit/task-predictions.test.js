const { __test } = require('../../src/app.js');

describe('task prediction helpers', () => {
  it('resolves an active prediction as success when task completes before deadline', () => {
    const task = {
      id: 't_1',
      text: 'Ship feature',
      completed: false,
      completedAt: null,
      archivedAt: null,
      nextRecurringAt: null,
      completionPointsAwardedAt: null,
      prediction: {
        id: 'pred_1',
        probability: 90,
        madeAt: '2026-02-01T09:00:00.000Z',
        resolveBy: '2026-02-01T18:00:00.000Z',
        outcome: 'open',
        madeInRootId: 'root_1',
        madeInRootName: 'Work',
      },
      predictionHistory: [],
    };

    __test.setTaskCompleted(task, true, new Date('2026-02-01T12:00:00.000Z'), {
      awardPoints: false,
      syncAncestors: false,
    });

    expect(task.prediction).toBeNull();
    expect(task.predictionHistory).toHaveLength(1);
    expect(task.predictionHistory[0].outcome).toBe('success');
    expect(task.predictionHistory[0].probability).toBe(90);
  });

  it('resolves an overdue active prediction as failure', () => {
    const task = {
      id: 't_2',
      text: 'Write memo',
      completed: false,
      completedAt: null,
      prediction: {
        id: 'pred_2',
        probability: 70,
        madeAt: '2026-02-01T09:00:00.000Z',
        resolveBy: '2026-02-01T10:00:00.000Z',
        outcome: 'open',
        madeInRootId: 'root_1',
        madeInRootName: 'Work',
      },
      predictionHistory: [],
    };

    const changed = __test.maybeResolveTaskPrediction(task, new Date('2026-02-01T10:30:00.000Z'));

    expect(changed).toBe(true);
    expect(task.prediction).toBeNull();
    expect(task.predictionHistory[0].outcome).toBe('failure');
  });

  it('groups resolved predictions into calibration buckets and computes brier score', () => {
    const entries = [
      { probability: 80, outcome: 'success' },
      { probability: 80, outcome: 'failure' },
      { probability: 20, outcome: 'success' },
    ];

    const buckets = __test.predictionCalibrationRows(entries);
    const brier = __test.predictionBrierScore(entries);

    expect(buckets).toEqual([
      expect.objectContaining({
        label: '20-29%',
        total: 1,
        successes: 1,
      }),
      expect.objectContaining({
        label: '80-89%',
        total: 2,
        successes: 1,
      }),
    ]);
    expect(brier).toBeCloseTo(0.44, 2);
  });
});
