const fs = require('fs');
const path = require('path');
const { score } = require('../../public/js/agent-fuzzy-search');

const names = ['AgentsMCPspace', 'Local News - AWS_c1', 'chatmcp-test-agent', 'notes-onro-1', 'Reviewer Bot',
  'Deploy Helper', 'Grok Bot', 'Reviewer 4', 'Reviewer 44', 'Reviewer 45', 'עוזר נתונים'];
const search = query => names.map(name => ({ name, rank: score(query, [name]) }))
  .filter(match => match.rank > 0).sort((a, b) => b.rank - a.rank).map(match => match.name);

describe('agent fuzzy search', () => {
  it.each([
    ['agnets', 'AgentsMCPspace'], // swapped letters
    ['gork', 'Grok Bot'],
    ['deply', 'Deploy Helper'], // missing letter
    ['hlper', 'Deploy Helper'],
    ['deploi', 'Deploy Helper'], // wrong letter
    ['notes onro', 'notes-onro-1'], // separators don't matter
    ['notesonro', 'notes-onro-1'],
    ['onro notes', 'notes-onro-1'], // word order doesn't matter
    ['aws c1', 'Local News - AWS_c1'],
    ['mcp space', 'AgentsMCPspace'], // camelCase counts as words
    ['GROK', 'Grok Bot'],
    ['נתונים', 'עוזר נתונים']
  ])('finds %s', (query, name) => {
    expect(search(query)).toContain(name);
  });

  it('keeps numbered agents apart', () => {
    expect(search('reviewer 44')).toEqual(['Reviewer 44']);
    expect(search('45')).toEqual(['Reviewer 45']);
    expect(search('4')[0]).toBe('Reviewer 4');
  });

  it('requires every word to match', () => {
    expect(search('grok deploy')).toEqual([]);
  });

  it('does not guess from very short or unrelated text', () => {
    expect(search('zzzz')).toEqual([]);
    expect(search('xq')).toEqual([]);
  });

  it('ranks exact matches above typo matches', () => {
    expect(score('bot', ['Grok Bot'])).toBeGreaterThan(score('bots', ['Grok Bot']));
    expect(score('grok', ['Grok Bot'])).toBeGreaterThan(score('gork', ['Grok Bot']));
    expect(score('news', ['Local News'])).toBeGreaterThan(score('news', [{ text: 'Local News', weight: 0.4 }]));
  });

  it('matches queries made only of punctuation literally', () => {
    expect(score('-', ['notes-onro-1'])).toBeGreaterThan(0);
    expect(score('-', ['Grok Bot'])).toBe(0);
  });

  it('never fuzzes literal fields, which are shared by every agent', () => {
    expect(score('sandard', [{ text: 'standard', literal: true }])).toBe(0);
    expect(score('stand', [{ text: 'standard', literal: true }])).toBeGreaterThan(0);
  });

  it('is loaded before every page that runs dashboard.js', () => {
    for (const view of ['dashboard.ejs', 'demo.ejs']) {
      const html = fs.readFileSync(path.join(__dirname, '../../views', view), 'utf8');
      expect(html.indexOf('/js/agent-fuzzy-search.js')).toBeGreaterThan(-1);
      expect(html.indexOf('/js/agent-fuzzy-search.js')).toBeLessThan(html.lastIndexOf('/js/dashboard.js'));
    }
  });
});
