/**
 * Serialize a value to JSON safe for embedding directly inside an inline
 * <script> tag without risking script-tag breakout or template-literal
 * injection. Escapes the bytes that matter:
 *
 *   <   prevents </script> closure
 *   >   defense in depth against malformed HTML parsers
 *   &   defense in depth against HTML entity confusion
 *   U+2028 / U+2029 are valid inside JSON strings but terminate JS
 *       statements, which would break any embedded expression.
 *
 * Regexes for U+2028/2029 are built via RegExp() so this source file
 * stays pure ASCII (literal line separators in source files cause
 * parser ambiguity).
 */
const LINE_SEP = new RegExp('\\u2028', 'g');
const PARA_SEP = new RegExp('\\u2029', 'g');

function safeJsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(LINE_SEP, '\\u2028')
    .replace(PARA_SEP, '\\u2029');
}

module.exports = { safeJsonForScript };
