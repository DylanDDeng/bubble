const assert = require('node:assert/strict');
const fs = require('node:fs');

module.exports = async ({ js, click, capture, delay, win, expected, fixture }) => {
  const active = () => js('qa.tabs.getState().activeTabId');
  const filterLabel = () => js('document.querySelector(' + JSON.stringify('[aria-label="Filter board by project"]') + ').textContent');
  const count = () => js('qa.tabs.getState().tabs.length');
  const selectTab = async id => {
    await click('[data-app-tab-id="' + id + '"]');
    await delay(200);
  };
  const key = async (keyCode, modifiers) => {
    win.webContents.sendInputEvent({type:'keyDown', keyCode, modifiers});
    win.webContents.sendInputEvent({type:'keyUp', keyCode, modifiers});
    await delay(250);
  };
  await js('(async()=>{qa.board=(await import("/src/ui/store/useBoardStore.ts")).useBoardStore;})()');
  await click('[aria-label="KanBan"]');
  await delay(300);
  if (process.env.QA_PHASE === 'seed') {
    assert.equal(await count(), 4, 'rail opens a board without overwriting chat tabs');
    const first = await active();
    await js('qa.board.getState().setShowEmptyColumns(true);qa.board.setState({hiddenStages:{}});qa.project=qa.app.getState().sessions[' + JSON.stringify(expected.ids[0]) + '].cwd;qa.task=qa.board.getState().addTask({title:"Kanban independent task",projectCwd:qa.project,description:"Task detail"});for(let i=0;i<16;i++)qa.board.getState().addTask({title:"Scroll fixture "+i,projectCwd:qa.project,stage:"backlog"})');
    await delay(250);
    await click('[aria-label="Filter board by project"]');
    await js('Array.from(document.querySelectorAll("button")).find(b=>b.textContent.includes("git-workspace")&&b.closest(".popover-surface")).id="qa-project-choice"');
    await click('#qa-project-choice');
    await js('document.querySelector("[data-board-scroll=columns]").scrollLeft=180;document.querySelector("[data-board-scroll=backlog]").scrollTop=240');
    await delay(250);
    assert.equal(await js('qa.tabs.getState().tabs.find(t=>t.id===qa.tabs.getState().activeTabId).board.scroll.backlog.top'), 240);
    await click('[aria-label="New Kanban tab"]');
    const second = await active();
    assert.notEqual(first, second);
    assert.equal(await count(), 5);
    assert.equal(await js('qa.app.getState().activeWorkspace'), 'board');
    assert.equal(await filterLabel(), 'All Projects');
    assert.equal(await js('document.querySelector("[data-board-scroll=columns]").scrollLeft'), 0);
    assert.equal(await js('document.querySelector("[data-board-scroll=backlog]").scrollTop'), 0);
    await selectTab(first);
    assert.ok((await filterLabel()).includes('git-workspace'));
    assert.equal(await js('document.querySelector("[data-board-scroll=columns]").scrollLeft'), 180);
    assert.equal(await js('document.querySelector("[data-board-scroll=backlog]").scrollTop'), 240);
    // Task navigation is scoped to the active tab, including its own history.
    await js('qa.board.getState().setSelectedTask(qa.task)');
    await delay(200);
    await selectTab(second);
    assert.equal(await js('qa.board.getState().selectedTaskId'), null);
    await selectTab(first);
    assert.equal(await js('qa.board.getState().selectedTaskId===qa.task'), true);
    await js('qa.tabs.getState().goBack()');await delay(200);
    assert.equal(await js('qa.board.getState().selectedTaskId'), null);
    assert.equal(await js('document.querySelector("[data-board-scroll=backlog]").scrollTop'), 240);
    await js('qa.tabs.getState().goForward()');await delay(200);
    assert.equal(await js('qa.board.getState().selectedTaskId===qa.task'), true);
    // Plus from detail and Cmd+T both create fresh overview pages.
    await click('[aria-label="New Kanban tab"]');
    const third = await active();
    assert.equal(await js('qa.board.getState().selectedTaskId'), null);
    await key('t', ['meta']);
    const fourth = await active();
    assert.notEqual(third, fourth);
    assert.equal(await count(), 7);
    await key('w', ['meta']);
    assert.equal(await count(), 6);
    assert.equal(await js('qa.app.getState().activeWorkspace'), 'board');
    await js('qa.tabs.getState().closeTab(' + JSON.stringify(third) + ')');await delay(200);
    assert.equal(await count(), 5);
    await selectTab(second);
    await capture('kanban-independent-tabs');
    for (let i=0;i<3;i++) {
      await click('[aria-label="Chats"]');
      assert.equal(await js('qa.app.getState().activeSessionId'), expected.ids[2]);
      await click('[aria-label="KanBan"]');
      assert.equal(await count(), 5, 'workspace switching reuses the board');
    }
    expected.kanban = { first, second, task: await js('qa.task') };
  } else {
    const { first, second, task } = expected.kanban;
    assert.equal(await count(), 5, 'restart and rail entry do not create extra pages');
    await selectTab(second);
    assert.equal(await js('qa.board.getState().selectedTaskId'), null);
    assert.equal(await filterLabel(), 'All Projects');
    await selectTab(first);
    assert.equal(await js('qa.board.getState().selectedTaskId'), task);
    await js('qa.tabs.getState().goBack()');await delay(200);
    assert.ok((await filterLabel()).includes('git-workspace'));
    assert.equal(await js('document.querySelector("[data-board-scroll=columns]").scrollLeft'), 180);
    assert.equal(await js('document.querySelector("[data-board-scroll=backlog]").scrollTop'), 240);
    await capture('kanban-tabs-restored');
  }
  await click('[aria-label="Chats"]');
  assert.equal(await js('qa.app.getState().activeSessionId'), expected.ids[2]);
  assert.deepEqual(await js('qa.tabs.getState().tabs.filter(t=>t.view.kind==="chat")'), expected.tabs.filter(t=>t.view.kind==='chat'), 'original chat views and histories remain intact');
  if (process.env.QA_PHASE === 'seed') {
    expected.tabs = await js('qa.tabs.getState().tabs');
    expected.active = await active();
    fs.writeFileSync(fixture, JSON.stringify(expected));
  }
  console.log('KANBAN_TABS_PASS ' + process.env.QA_PHASE);
};
