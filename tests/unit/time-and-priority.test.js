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
});

