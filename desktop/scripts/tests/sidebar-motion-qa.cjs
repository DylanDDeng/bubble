const assert = require('node:assert/strict');

module.exports = async ({ js, click, capture, delay, win }) => {
  const trigger = '[data-window-navigation] [data-sidebar-trigger]';
  await js(`qa.motionTrigger=document.querySelector('${trigger}');qa.motionNav=document.querySelector('[data-window-navigation]');
    qa.sampleSidebar=()=>{const sidebar=document.querySelector('.aegis-sidebar').getBoundingClientRect(), surface=document.querySelector('.bubble-workspace-surface').getBoundingClientRect(), nav=qa.motionNav.getBoundingClientRect(), panel=document.querySelector('#bubble-project-sidebar');const dragOverlap=Array.from(document.querySelectorAll('.drag-region')).some(e=>{const r=e.getBoundingClientRect();return getComputedStyle(e).webkitAppRegion==='drag'&&r.width>0&&r.height>0&&r.left<nav.right&&r.right>nav.left&&r.top<nav.bottom&&r.bottom>nav.top});const corner=Array.from(document.querySelectorAll('.drag-region')).some(e=>{const r=e.getBoundingClientRect();return getComputedStyle(e).webkitAppRegion==='drag'&&r.left<=42&&r.right>=42&&r.top<=20&&r.bottom>=20});return {dragOverlap,corner,width:sidebar.width,left:surface.left,top:surface.top,x:nav.x,y:nav.y,opacity:Number(getComputedStyle(panel).opacity),clearance:parseFloat(getComputedStyle(document.querySelector('.aegis-window-shell')).getPropertyValue('--bubble-sidebar-width')),same:document.querySelector('${trigger}')===qa.motionTrigger,count:document.querySelectorAll('[data-sidebar-trigger]').length}};
    qa.startSidebarSamples=()=>{qa.sidebarSamples=[];const start=performance.now();qa.motionDone=new Promise(resolve=>{const frame=()=>{qa.sidebarSamples.push(qa.sampleSidebar());if(performance.now()-start<650)requestAnimationFrame(frame);else resolve(qa.sidebarSamples)};frame()})};void 0`);
  const sample = () => js('qa.sampleSidebar()');
  const checkFrames = (frames, base, closed, expanded) => {
    assert.ok(frames.some(f => f.width > closed+5 && f.width < expanded-5), 'intermediate layout frames exist');
    for (const f of frames) {
      assert.equal(f.dragOverlap,false,'native drag rectangles must never cover window navigation');
      assert.equal(f.corner,true,'the window corner beside the traffic lights drags the window');
      assert.ok(f.same && f.count===1, 'one mounted button across every animation frame');
      assert.equal(f.x, base.x, 'navigation x stays fixed');
      assert.equal(f.y, base.y, 'navigation y stays fixed');
      assert.equal(f.top, base.top, 'content does not jump vertically');
      assert.ok(Math.abs(f.width-f.left)<1, 'content tracks sidebar width in the same frame');
      assert.ok(Math.abs(f.clearance-f.width)<1, 'titlebar uses the same animated width');
      const opacity=Math.max(0,Math.min(1,(f.width-closed)/(expanded-closed)));
      assert.ok(Math.abs(f.opacity-opacity)<0.02, 'opacity stays synchronized with width: '+JSON.stringify({frame:f,expected:opacity}));
    }
  };
  for (const workspace of ['chat','board']) {
    if(workspace==='board') await click('[aria-label="KanBan"]');
    await js('qa.app.getState().setSidebarWidth(310);qa.app.getState().setSidebarCollapsed(false)');await delay(450);
    const base=await sample(), closed=44;
    await js('qa.startSidebarSamples()');await click(trigger);
    const closing=await js('qa.motionDone');checkFrames(closing,base,closed,354);
    assert.equal(closing.at(-1).width,closed);
    await capture('sidebar-motion-'+workspace+'-closed');
    await js('qa.startSidebarSamples()');await click(trigger);
    const opening=await js('qa.motionDone');checkFrames(opening,base,closed,354);
    assert.equal(opening.at(-1).width,354);
    await capture('sidebar-motion-'+workspace+'-open');
    // Renderer-input quick reversal before the first transition finishes.
    const point=await js(`(()=>{const r=qa.motionTrigger.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    const press=()=>{win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});};
    await js('qa.startSidebarSamples()');press();await delay(70);press();
    const reverse=await js('qa.motionDone');checkFrames(reverse,base,closed,354);
    assert.equal(reverse.at(-1).width,354,'reversal returns to the expanded endpoint');
    assert.ok(Math.min(...reverse.map(f=>f.width))>closed+5,'reversal does not snap to collapsed endpoint');
  }
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await delay(100);
  await click(trigger);
  assert.equal((await sample()).width,44,'reduced motion immediately settles at collapsed width');
  await click(trigger);
  assert.equal((await sample()).width,354,'reduced motion immediately settles at expanded width');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[]});
  await click('[aria-label="Chats"]');
  // Restore the independent defaults expected by the existing restart suite.
  await js('qa.app.setState({boardSidebarCollapsed:true,boardSidebarWidth:310})');await delay(400);
  console.log('SIDEBAR_MOTION_PASS: fixed controls, synchronized frames, rapid reversal, reduced motion');
};
