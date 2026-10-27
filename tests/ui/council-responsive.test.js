/** @jest-environment jsdom */
const fs = require('fs');
const path = require('path');
const source = fs.readFileSync(path.join(__dirname, '../../public/js/dashboard.js'), 'utf8');
const functions = source.slice(source.indexOf('function calculateCouncilFit('), source.indexOf('const ORBIT_DRAG_THRESHOLD'));
const api = new Function('SPHERE_SIZE_LIMITS', 'orbitDragState', 'currentOrbitLayout', 'projectOrbitPoint', functions + '\nreturn {calculateCouncilFit, calculateCouncilTilt, refreshCouncilFit, setupResponsiveCouncil};')(
  { min: 28, max: 56 }, null, { order: ['b', 'a'] }, (angle, radius) => ({ x: 50 + radius * Math.cos(angle * Math.PI / 180), y: 50 + radius * Math.sin(angle * Math.PI / 180) }));
const ring = (count, radius = 46, squash = 1) => Array.from({length: count}, (_, i) => ({
  x: 50 + radius * Math.cos((i * 360 / count - 90) * Math.PI / 180),
  y: 50 + radius * Math.sin((i * 360 / count - 90) * Math.PI / 180) * squash
}));
test('spheres shrink with actual separation, including inner rings', () => {
  const roomy = api.calculateCouncilFit(ring(12), 600, 600);
  const narrow = api.calculateCouncilFit(ring(12), 400, 400);
  expect(roomy.compact).toBe(false); expect(narrow.sphereSize).toBeGreaterThan(0);
  expect(narrow.sphereSize).toBeLessThan(roomy.sphereSize);
  expect(api.calculateCouncilFit(ring(12, 26), 400, 400).sphereSize).toBeLessThan(narrow.sphereSize);
});
test.each([12, 60, 150, 500])('%i seats in the screenshot dimensions stay in non-overlapping orbits', count => {
  const fit = api.calculateCouncilFit(ring(count), 393, 244);
  expect(fit.compact).toBe(true); expect(fit.sphereSize).toBeGreaterThan(0);
  const distance = 2 * .46 * fit.orbitSize * Math.sin(Math.PI / count);
  expect(fit.sphereSize * 1.3).toBeLessThan(distance);
});
test('squashed rings and mixed adjacent rings use their actual nearest separation', () => {
  expect(api.calculateCouncilFit(ring(12, 46, .4), 500, 500).sphereSize)
    .toBeLessThan(api.calculateCouncilFit(ring(12), 500, 500).sphereSize);
  expect(api.calculateCouncilFit([{x: 50, y: 4}, {x: 50, y: 14}], 500, 500).sphereSize).toBeLessThan(34);
});
test('groups shrink their footprint before their satellites collide', () => {
  const group = api.calculateCouncilFit(ring(12), 400, 400, true);
  expect(group.sphereSize).toBeLessThan(api.calculateCouncilFit(ring(12), 400, 400).sphereSize);
});
test('hidden and empty councils have finite results', () => {
  for (const points of [[], ring(3)]) {
    const fit = api.calculateCouncilFit(points, 0, 0);
    expect(Number.isFinite(fit.sphereSize)).toBe(true);
    expect(fit.orbitSize).toBe(0);
  }
});
test('reflow updates sizes, restores orbit layout, and provides full accessible names', () => {
  document.body.innerHTML = '<div id="councilCircle"><div class="council-orbit"><div id="agentSeats"><div class="agent-seat" data-agent-id="a" data-agent-name="Long agent name" style="left:50%;top:4%"></div><div class="agent-seat" data-agent-id="b" style="left:50%;top:96%"></div></div></div></div>';
  const circle = document.getElementById('councilCircle');
  let dimension = 244;
  Object.defineProperty(circle, 'clientWidth', { get: () => dimension });
  Object.defineProperty(circle, 'clientHeight', { get: () => dimension });
  const seat = document.querySelector('.agent-seat'), click = jest.fn();
  seat.addEventListener('click', click);
  api.refreshCouncilFit();
  expect(circle.classList.contains('council-grid-view')).toBe(false);
  expect(circle.classList.contains('council-compact')).toBe(true);
  expect(seat.getAttribute('aria-label')).toBe('Long agent name');
  expect(seat.style.order).toBe('1');
  seat.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true}));
  expect(click).toHaveBeenCalledTimes(1);
  dimension = 600; api.refreshCouncilFit();
  expect(circle.classList.contains('council-grid-view')).toBe(false);
  expect(circle.querySelector('.council-orbit').style.getPropertyValue('--council-sphere-size')).toBe('56px');
  seat.dispatchEvent(new KeyboardEvent('keydown', {key:' ', bubbles:true}));
  expect(click).toHaveBeenCalledTimes(2); // no duplicated keyboard listeners on reflow
});

test('repeated resizing keeps orbital coordinates and restores sphere sizes', () => {
  const points = ring(12), initial = JSON.stringify(points);
  const sizes = [600, 400, 244, 150, 244, 400, 600].map(size => api.calculateCouncilFit(points, size, size));
  expect(sizes[2].sphereSize).toBeLessThan(sizes[1].sphereSize);
  expect(sizes[3].sphereSize).toBeLessThan(sizes[2].sphereSize);
  expect(sizes[0]).toEqual(sizes[6]);
  expect(JSON.stringify(points)).toBe(initial);
});
test('small chambers tilt the orbit slightly, and roomy ones stay flat', () => {
  expect(api.calculateCouncilTilt(600, 600)).toBe(1);
  const mid = api.calculateCouncilTilt(384, 392), small = api.calculateCouncilTilt(244, 244);
  expect(mid).toBeLessThan(1); expect(small).toBeLessThan(mid);
  expect(small).toBeCloseTo(0.82); expect(api.calculateCouncilTilt(0, 0)).toBeCloseTo(0.82);
  document.body.innerHTML = '<div id="councilCircle"><div class="council-orbit"><div id="agentSeats"><div class="agent-seat" data-agent-id="a" data-council-angle="90" data-council-radius="46"></div></div></div></div>';
  const circle = document.getElementById('councilCircle');
  let dimension = 244;
  Object.defineProperty(circle, 'clientWidth', { get: () => dimension });
  Object.defineProperty(circle, 'clientHeight', { get: () => dimension });
  api.refreshCouncilFit();
  expect(circle.style.getPropertyValue('--council-orbit-squash')).toBe('0.820');
  dimension = 700; api.refreshCouncilFit();
  expect(circle.style.getPropertyValue('--council-orbit-squash')).toBe('1.000');
});
