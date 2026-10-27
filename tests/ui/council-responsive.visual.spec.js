const { test, expect } = require('@playwright/test');
const express = require('express');
const ejs = require('ejs');
const path = require('path');
const root = path.join(__dirname, '../..');
const { assetUrl } = require('../../src/utils/assetUrl');
const DeviceBadge = require('../../public/js/device-badge');
const { safeJsonForScript } = require('../../src/utils/safeJsonHelper');
const agents = Array.from({length: 80}, (_, i) => ({ agentId: `agent-${i}`, name: `Cluster reviewer ${i} with a long name`,
  agentType: 'standard', position: i + 1, highestPriority: i % 3 === 0 ? 'high' : 'low',
  lastMessagePriority: i % 3 === 0 ? 'high' : 'low', unreadCount: i % 4 === 0 ? 2 : 0, marbleSvg: '' }));
let server, origin;
test.beforeEach(async ({page}) => {
  // Layout checks use local assets and synthetic agent data exclusively.
  await page.route('https://fonts.googleapis.com/**', route => route.abort());
  await page.route('https://fonts.gstatic.com/**', route => route.abort());
  await page.addInitScript(() => localStorage.setItem('cos_modal_dismissed_at', new Date().toISOString()));
});
test.beforeAll(async () => {
  const app = express(); app.use(express.json());
  app.use(express.static(path.join(root, 'public')));
  app.get('/dashboard', async (_req, res) => {
    const locals = { agents, groups: [], encryptionSalt: '', isGoogleAuth: false, csrfToken: 'fixture', cspNonce: 'fixture',
      assetUrl, DeviceBadge, safeJsonForScript, currentPath: '/dashboard', user: {userId:'fixture',email:'fixture@example.test'} };
    const body = await ejs.renderFile(path.join(root, 'views/dashboard.ejs'), locals);
    res.send(await ejs.renderFile(path.join(root, 'views/layout.ejs'), {...locals,body}));
  });
  app.get('/api/user/agents', (_req,res) => res.json({agents,groups:[]}));
  app.get('/api/user/messages/:agentId', (_req,res) => res.json({messages:[],hasMore:false}));
  app.get('/dashboard/config', (_req,res) => res.json({}));
  app.use('/api', (_req,res) => res.json([]));
  server = await new Promise(resolve => { const listener = app.listen(0,'127.0.0.1',()=>resolve(listener)); });
  origin = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => {if(server) await new Promise(resolve=>server.close(resolve));});
async function ready(page, width = 1440, height = 1000) {
  await page.setViewportSize({width,height});
  await page.goto(origin+'/dashboard', {waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.dashboardReady);
  const later = page.getByRole('button',{name:'Maybe later',exact:true});
  if(await later.isVisible()) await later.click();
  await expect(page.locator('#agentSeats > .agent-seat')).toHaveCount(80);
  // Stop any in-flight poll's finally block from restarting the timer and
  // replacing the smaller datasets installed by individual layout scenarios.
  await page.evaluate(()=>{scheduleAgentPoll=()=>{};stopAgentPolling();});
  await page.waitForFunction(()=>!agentPollInFlight);
}
async function assertOrbits(page, count, activate = true) {
  await expect(page.locator('#councilCircle')).not.toHaveClass(/council-grid-view/);
  await expect(page.locator('#agentSeats > .agent-seat')).toHaveCount(count);
  await expect(page.locator('.council-center')).toBeVisible();
  await expect(page.locator('.council-rings')).toBeVisible();
  await expect.poll(() => page.locator('#agentSeats').evaluate(container => {
    const box = document.getElementById('councilCircle').getBoundingClientRect();
    const spheres = [...container.querySelectorAll('.council-agent-sphere, .group-seat__center')].map(sphere => {
      const r = sphere.getBoundingClientRect();
      return {x:r.x+r.width/2,y:r.y+r.height/2,radius:r.width/2,left:r.left,right:r.right,top:r.top,bottom:r.bottom};
    });
    const problems = [];
    if (getComputedStyle(container).display === 'grid') problems.push('grid');
    for (let i=0;i<spheres.length;i++) {
      const seat=spheres[i];
      if (seat.left < box.left-1 || seat.right > box.right+1 || seat.top < box.top-1 || seat.bottom > box.bottom+1 || seat.radius <= 0) problems.push(`bounds: ${i}`);
      for(let j=0;j<i;j++) {
        const other=spheres[j];
        if (Math.hypot(seat.x-other.x,seat.y-other.y) < seat.radius+other.radius-.5) problems.push(`overlap: ${i},${j}`);
      }
    }
    return problems;
  })).toEqual([]);
  if (activate) {
    const last=page.locator('#agentSeats > .agent-seat').last();
    await last.focus(); await page.keyboard.press('Enter');
    await expect.poll(()=>page.evaluate(()=>window.DashboardHelpers.getSelectedAgentIdentity()?.agentId)).toBe(`agent-${count-1}`);
  }
}
test('80 agents fit the real chamber, remain reachable, and resize through the divider',async({page})=>{
  await ready(page); await assertOrbits(page,80);
  await page.locator('#agentSeats').evaluate(el=>el.scrollTop=0);
  const handle=page.locator('#councilResizeHandle'), bounds=await handle.boundingBox();
  const chamber=page.locator('.council-chamber'), initial=await chamber.boundingBox();
  await page.mouse.move(bounds.x+bounds.width/2,bounds.y+bounds.height/2);
  await page.mouse.down(); await page.mouse.move(bounds.x+110,bounds.y+bounds.height/2,{steps:8}); await page.mouse.up();
  await expect.poll(async()=> (await chamber.boundingBox()).width).toBeGreaterThan(initial.width+40);
  await assertOrbits(page,80);
  await page.screenshot({path:test.info().outputPath('crowded-council.png')});
});
test('the 393 by 244 screenshot area keeps non-overlapping spheres in rings',async({page})=>{
  await ready(page);
  await page.evaluate(()=>{
    stopAgentPolling();
    const circle=document.getElementById('councilCircle');
    circle.style.cssText='position:fixed;left:0;top:0;width:393px;height:244px;min-height:0;max-height:none;z-index:200;background:#070e20';
    agentListCache.agents=currentAgentList.slice(0,12); updateAgentListUI(agentListCache.agents);
  });
  await assertOrbits(page,12);
  await page.evaluate(()=>window.CouncilSharing.updateContexts([{agentId:'remote',agentName:'Shared teammate',conversationId:'shared',mode:'shared',role:'participant',membershipStatus:'active'}]));
  await expect(page.locator('#sharedGalaxy')).toBeVisible();
  await page.locator('#agentSeats').evaluate(el=>el.scrollTop=0);
  await page.locator('#councilCircle').screenshot({path:test.info().outputPath('compact-393x244.png')});
});
test('small councils shrink smoothly and keep their circles when space returns',async({page})=>{
  await ready(page);
  await page.evaluate(()=>{
    stopAgentPolling();
    const circle=document.getElementById('councilCircle');
    circle.style.cssText='position:fixed;left:0;top:0;width:600px;height:600px;min-height:0;max-height:none;z-index:200;background:#070e20';
    const subset=currentAgentList.slice(0,12).map(a=>({...a,highestPriority:'low',lastMessagePriority:'low',unreadCount:0}));
    agentListCache.agents=subset; updateAgentListUI(subset);
  });
  await expect(page.locator('#councilCircle')).not.toHaveClass(/council-grid-view/);
  const size=()=>page.locator('.council-agent-sphere').first().evaluate(el=>el.getBoundingClientRect().width);
  const large=await size();
  await page.locator('#councilCircle').evaluate(el=>{el.style.width='400px';el.style.height='400px';});
  await expect.poll(size).toBeLessThan(large-3);
  await expect(page.locator('#councilCircle')).not.toHaveClass(/council-grid-view/);
  await page.locator('#councilCircle').evaluate(el=>{el.style.width='300px';el.style.height='240px';});
  await assertOrbits(page,12);
  for (const [width,height] of [[220,180],[393,244],[500,300]]) {
    await page.locator('#councilCircle').evaluate((el,{width,height})=>{el.style.width=width+'px';el.style.height=height+'px';},{width,height});
    await assertOrbits(page,12,false);
  }
  await page.locator('#councilCircle').evaluate(el=>{el.style.width='600px';el.style.height='600px';});
  await expect(page.locator('#councilCircle')).not.toHaveClass(/council-grid-view/);
  await expect.poll(size).toBeGreaterThanOrEqual(55);
});
test('group spheres and group members stay navigable in a crowded chamber',async({page})=>{
  await ready(page);
  await page.evaluate(()=>{
    stopAgentPolling();
    document.getElementById('councilCircle').style.cssText='height:244px;min-height:0;flex:none';
    currentGroups=[{groupId:'work',groupName:'Review team',memberIds:currentAgentList.slice(0,12).map(a=>a.agentId)}];
    cachedGroupPartition=null; lastAgentListRenderSignature=''; updateAgentListUI(currentAgentList);
  });
  await expect(page.locator('#agentSeats .group-seat')).toHaveCount(1);
  await page.locator('#agentSeats .group-seat').focus(); await page.keyboard.press('Enter');
  await expect(page.locator('#groupBackBtn')).toBeVisible();
  await expect(page.locator('#agentSeats > .agent-seat')).toHaveCount(12);
  await assertOrbits(page,12);
  await page.locator('#groupBackBtn').click();
  await expect(page.locator('#agentSeats > .agent-seat')).toHaveCount(68);
});
test('mobile keeps the searchable list and can reach the last of 80 agents',async({page})=>{
  await ready(page,390,844);
  await page.evaluate(()=>setMobileListExpanded(true));
  await expect(page.locator('#councilCircle')).toBeHidden();
  const last=page.locator('#agentListScroll .agent-list-item[data-agent-id="agent-79"]');
  await last.scrollIntoViewIfNeeded(); await last.click();
  await expect.poll(()=>page.evaluate(()=>window.DashboardHelpers.getSelectedAgentIdentity()?.agentId)).toBe('agent-79');
});

test('orbit dragging reorders agents and still opens a side chat',async({page})=>{
  await ready(page);
  await page.evaluate(()=>{const subset=currentAgentList.slice(0,12).map(a=>({...a,highestPriority:'low',lastMessagePriority:'low',unreadCount:0}));agentListCache.agents=subset;updateAgentListUI(subset);});
  await assertOrbits(page,12,false);
  const sphere=id=>page.locator(`#agentSeats > .agent-seat[data-agent-id="${id}"] .council-agent-sphere`);
  const first=await sphere('agent-0').boundingBox(), third=await sphere('agent-2').boundingBox();
  await page.mouse.move(first.x+first.width/2,first.y+first.height/2); await page.mouse.down();
  await page.mouse.move(third.x+third.width/2,third.y+third.height/2,{steps:8}); await page.mouse.up();
  await expect.poll(()=>page.evaluate(()=>currentOrbitLayout.order[2])).toBe('agent-0');
  const start=await sphere('agent-0').boundingBox(), chat=await page.locator('.chat-drop-container').boundingBox();
  await page.mouse.move(start.x+start.width/2,start.y+start.height/2); await page.mouse.down();
  await page.mouse.move(chat.x+chat.width/2,chat.y+chat.height/2,{steps:8});
  await expect(page.locator('#chatAreaDropOverlay')).toHaveClass(/dropzone-hover/);
  await page.mouse.up();
  await expect.poll(()=>page.evaluate(()=>window.MultiChatManager.isOpen('agent-0'))).toBe(true);
});
test('rerender preserves focused spheres, and empty councils recover',async({page})=>{
  await ready(page);
  const last=page.locator('#agentSeats > .agent-seat').last();
  await last.focus();
  const scroll=await page.locator('#agentSeats').evaluate(el=>el.scrollTop);
  await page.evaluate(()=>{
    lastAgentListRenderSignature=''; updateAgentListUI(currentAgentList.map(a=>({...a,unreadCount:a.unreadCount+1})));
  });
  await expect(last).toBeFocused();
  expect(await page.locator('#agentSeats').evaluate(el=>el.scrollTop)).toBe(scroll);
  await page.evaluate(()=>{lastAgentListRenderSignature='';updateAgentListUI([]);});
  await expect(page.locator('#councilCircle')).not.toHaveClass(/council-grid-view/);
  await expect(page.locator('.council-empty-state')).toBeVisible();
});
