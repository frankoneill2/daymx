const { __test } = require('../../src/app.js');

describe('task creation defaults', () => {
  it('inherits contexts and locations from the source task', () => {
    const created = {
      contexts: [],
      locations: [],
      loc: '',
      priority: 3,
    };
    const source = {
      contexts: ['Work', 'Errands'],
      locations: ['home', 'laptop'],
      loc: 'home',
      priority: 1,
    };

    __test.inheritTaskCreationDefaults(created, source);

    expect(created.contexts).toEqual(['Work', 'Errands']);
    expect(created.locations).toEqual(['home', 'laptop']);
    expect(created.loc).toBe('home');
    expect(created.priority).toBe(3);
  });
});
