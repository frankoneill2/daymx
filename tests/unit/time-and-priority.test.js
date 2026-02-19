const { __test } = require('../../src/app.js');

describe('time and priority helpers', () => {
  it('normalizes durations from multiple input formats', () => {
    expect(__test.normalizeDurationValue('15m')).toBe(15);
    expect(__test.normalizeDurationValue('1h')).toBe(60);
    expect(__test.normalizeDurationValue(' 90 ')).toBe(90);
    expect(__test.normalizeDurationValue(null)).toBeNull();
    expect(__test.normalizeDurationValue('')).toBeNull();
    expect(__test.normalizeDurationValue('bad')).toBeNull();
  });

  it('formats minutes into readable labels', () => {
    expect(__test.formatDuration(5)).toBe('5m');
    expect(__test.formatDuration(60)).toBe('1h');
    expect(__test.formatDuration(75)).toBe('1h 15m');
  });

  it('normalizes and de-duplicates selected priorities', () => {
    expect(__test.normalizePriorityList([3, '1', 3, 6, 0, 'bad', 2])).toEqual([1, 2, 3]);
  });

  it('builds a stable local day key', () => {
    expect(__test.dayKeyFromDate(new Date(2026, 1, 7, 12, 30, 0))).toBe('2026-02-07');
  });

  it('classifies follow-up timing states', () => {
    const now = new Date(2026, 1, 7, 12, 0, 0);
    const overdue = { followUpAt: new Date(2026, 1, 7, 8, 0, 0).toISOString() };
    const today = { followUpAt: new Date(2026, 1, 7, 18, 0, 0).toISOString() };
    const upcoming = { followUpAt: new Date(2026, 1, 8, 9, 0, 0).toISOString() };

    expect(__test.followUpStatus(overdue, now).state).toBe('overdue');
    expect(__test.followUpStatus(today, now).state).toBe('today');
    expect(__test.followUpStatus(upcoming, now).state).toBe('upcoming');
    expect(__test.followUpStatus({}, now).state).toBe('none');
  });

  it('marks review completion and computes streak', () => {
    const now = new Date(2026, 1, 7, 12, 0, 0);
    const y1 = new Date(2026, 1, 6, 12, 0, 0);
    const y2 = new Date(2026, 1, 5, 12, 0, 0);
    const key = (d) => __test.dayKeyFromDate(d);
    const data = {
      dailyReview: {
        dayKey: key(now),
        active: false,
        idx: 0,
        currentId: null,
        completedDays: {
          [key(y1)]: true,
          [key(y2)]: true,
        },
      },
    };
    const marked = __test.markDailyReviewCompleted(data, now);
    expect(marked.changed).toBe(true);
    const streak = __test.reviewStreakInfo(data.dailyReview, now);
    expect(streak.streak).toBe(3);
    expect(streak.todayDone).toBe(true);
  });
});
