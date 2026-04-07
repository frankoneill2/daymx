const { __test } = require('../../src/app.js');

describe('task pin helpers', () => {
  it('creates a formatted link pin from a pasted URL', () => {
    const pin = __test.draftTaskPin('example.com/quarterly-roadmap');
    expect(pin).toMatchObject({
      type: 'link',
      domain: 'example.com',
      title: 'Quarterly Roadmap',
    });
    expect(pin.url).toBe('https://example.com/quarterly-roadmap');
    expect(pin.displayUrl).toBe('example.com/quarterly-roadmap');
  });

  it('uses markdown link labels when provided', () => {
    const pin = __test.draftTaskPin('[Roadmap doc](https://example.com/docs/q1-plan)');
    expect(pin).toMatchObject({
      type: 'link',
      title: 'Roadmap doc',
      domain: 'example.com',
    });
    expect(pin.displayUrl).toBe('example.com/docs/q1-plan');
  });

  it('stores plain text as a note pin', () => {
    const pin = __test.draftTaskPin('Remember to check Amber availability before swapping');
    expect(pin).toEqual({
      id: expect.any(String),
      type: 'note',
      text: 'Remember to check Amber availability before swapping',
    });
  });

  it('normalizes mixed pin lists and drops invalid entries', () => {
    const pins = __test.normalizeTaskPins([
      { id: 'n1', type: 'note', text: '  Keep this handy  ' },
      { id: 'l1', type: 'link', url: 'www.example.com/docs/start-here', title: '' },
      { id: 'bad1', type: 'note', text: '   ' },
      { id: 'bad2', type: 'link', url: 'not a link' },
    ]);

    expect(pins).toEqual([
      { id: 'n1', type: 'note', text: 'Keep this handy' },
      {
        id: 'l1',
        type: 'link',
        url: 'https://www.example.com/docs/start-here',
        title: 'Start Here',
        domain: 'example.com',
        displayUrl: 'example.com/docs/start-here',
      },
    ]);
  });
});
