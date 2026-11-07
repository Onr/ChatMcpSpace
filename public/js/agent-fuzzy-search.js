/* Typo-tolerant agent search shared by the dashboard pickers and their tests. */
(function (root) {
  'use strict';
  const fold = value => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  // "AgentsMCPspace" and "notes-onro_1" both break into searchable words.
  const splitWords = value => fold(String(value || '').replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2'))
    .split(/[^\p{L}\p{N}]+/u).filter(Boolean);

  // Optimal string alignment distance, so a swapped pair of letters costs one edit.
  function editDistance(a, b) {
    const rows = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) rows[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
          rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
        }
      }
    }
    return rows[a.length][b.length];
  }

  // Letters of the token in order, starting on a word and staying close together.
  function inOrderSpan(token, words) {
    const compact = words.join('');
    let best = Infinity;
    let wordStart = 0;
    for (const word of words) {
      let index = wordStart - 1;
      for (const char of token) {
        index = compact.indexOf(char, index + 1);
        if (index < 0) break;
      }
      if (index >= 0) best = Math.min(best, index - wordStart + 1);
      wordStart += word.length;
    }
    return best <= token.length * 2 ? best : null;
  }

  function typoDistance(token, words) {
    const allowed = token.length >= 7 ? 2 : 1;
    let best = Infinity;
    for (const word of words) {
      for (let length = token.length - 1; length <= token.length + 1; length++) {
        if (length > word.length && length > token.length - 1) break;
        best = Math.min(best, editDistance(token, word.slice(0, length)));
      }
    }
    return best <= allowed ? best : null;
  }

  function scoreToken(token, field) {
    const { words, text, compact } = field;
    if (compact === token) return 100;
    if (compact.startsWith(token)) return 90;
    if (words.includes(token)) return 85;
    if (words.some(word => word.startsWith(token))) return 80;
    const index = text.indexOf(token);
    if (index >= 0) return 70 - Math.min(index, 10);
    if (compact.includes(token)) return 55;
    // Numbers tell agents apart, so "44" must never match "45".
    if (field.literal || token.length < 3 || /\p{N}/u.test(token)) return 0;
    const span = inOrderSpan(token, words);
    if (span !== null) return 45 - (span - token.length);
    if (token.length < 4) return 0;
    const distance = typoDistance(token, words);
    return distance === null ? 0 : 30 - distance * 10;
  }

  /**
   * Rank how well a query matches some labelled text.
   * @param {string} query - What the user typed
   * @param {Array<string|{text: string, weight?: number, literal?: boolean}>} fields - Text to search
   * @returns {number} 0 for no match, higher for a better match
   */
  function score(query, fields) {
    const entries = fields.map(field => (typeof field === 'object' && field ? field : { text: field }))
      .filter(field => field.text)
      .map(field => {
        const words = splitWords(field.text);
        return { ...field, words, text: words.join(' '), compact: words.join(''), raw: fold(field.text) };
      });
    const tokens = splitWords(query);
    if (tokens.length === 0) {
      const literal = fold(query).trim();
      return literal && entries.some(field => field.raw.includes(literal)) ? 1 : 0;
    }
    let total = 0;
    for (const token of tokens) {
      const best = Math.max(0, ...entries.map(field => scoreToken(token, field) * (field.weight ?? 1)));
      if (best === 0) return 0;
      total += best;
    }
    return total / tokens.length;
  }

  const api = { score };
  // Same export shape as device-badge.js: some pages expose a CommonJS-like `module`.
  if (typeof window === 'object') window.AgentFuzzySearch = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AgentFuzzySearch = api;
})(typeof window === 'object' ? window : globalThis);
