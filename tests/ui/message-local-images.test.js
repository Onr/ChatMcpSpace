/** @jest-environment jsdom */
const fs = require('fs');
const path = require('path');
const dashboard = fs.readFileSync(path.join(__dirname, '../../public/js/dashboard.js'), 'utf8');
const source = dashboard.slice(dashboard.indexOf('function replaceUnreachableImages('), dashboard.indexOf('function escapeHtml('));
const replaceUnreachableImages = new Function(source + ';return replaceUnreachableImages;')();

test('an image linked by a path on the agent computer becomes a visible note', () => {
  const html = replaceUnreachableImages('<p>See <img src="/home/ubuntu/project/shot%20one.png" alt=""> and ' +
    '<img src="C:\\Users\\me\\a.png" alt="Settings &lt;b&gt;"></p>');
  document.body.innerHTML = html;
  expect(document.querySelector('img')).toBeNull();
  const notes = [...document.querySelectorAll('.message-image-unavailable')].map(note => note.textContent);
  expect(notes).toEqual([
    '[Image "shot one.png" is on the agent\'s computer and was not uploaded]',
    '[Image "Settings <b>" is on the agent\'s computer and was not uploaded]'
  ]);
  expect(document.querySelector('b')).toBeNull();
});

test('web, data and blob images are kept', () => {
  const html = '<img src="https://example.test/a.png" alt="a"><img src="data:image/png;base64,AA==" alt="b"><img src="blob:x" alt="c">';
  document.body.innerHTML = replaceUnreachableImages(html);
  expect(document.querySelectorAll('img')).toHaveLength(3);
  expect(replaceUnreachableImages('<p>no images</p>')).toBe('<p>no images</p>');
});
