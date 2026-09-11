const fs = require('fs');
const { chromium } = require('@playwright/test');
const now = '2026-09-11T09:15:00Z';
const members = [{ id: 'u1', githubLogin: 'lin', displayName: '林遥', kind: 'human', role: 'owner', joinedAt: now }, { id: 'u2', githubLogin: 'chen', displayName: '陈序', kind: 'human', role: 'member', joinedAt: now }];
const messages = ['新的设计语言已经更新到预览里了，导航和会话的边界更清楚。', '看到了，文件与话题也可以从这里直接进入。', '这次先集中确认阅读和回复体验，状态信息尽量保持轻量。'].map((text, i) => ({ id: 'm' + i, conversationId: 'c1', authorId: members[i % 2].id, authorName: members[i % 2].displayName, authorGithubLogin: members[i % 2].githubLogin, authorKind: 'human', kind: 'user', content: { format: 'blocks', plainText: text, blocks: [{ type: 'text', text }] }, plainText: text, createdAt: now, attachments: [], reactions: [] }));
const conversations = [{ id: 'c1', spaceId: 's1', type: 'group', title: '设计讨论', retentionCount: 1000, createdAt: now, lastActivityAt: now, messageCount: 3, memberCount: 2, lastMessagePlainText: messages[2].plainText, lastMessageAt: now, unreadCount: 2, notificationLevel: 'all', capabilities: { canSendMessage: true, canUploadFile: true, canManageMembers: true }, members, latestMessages: messages }, { id: 'c2', spaceId: 's1', type: 'direct', title: '陈序', retentionCount: 1000, createdAt: now, messageCount: 1, memberCount: 2, lastMessagePlainText: '待会儿见。', lastMessageAt: now, unreadCount: 0, notificationLevel: 'all', capabilities: { canSendMessage: true, canUploadFile: true }, members, latestMessages: [] }];
const bootstrap = { auth: { mode: 'github', inviteOnly: true, currentUser: members[0] }, space: { id: 's1', name: '青空工作室', slug: 'studio', createdBy: 'u1', createdAt: now }, policy: { dailyQuotaBytes: 1073741824, usedTodayBytes: 26214400, remainingQuotaBytes: 1047527424, messageRetentionCount: 1000, memberVisibilityBasis: 'direct_contacts' }, permissions: { canCreateMemberInvite: true, canCreatePrivilegedInvite: true, canManageMemberVisibility: true, canManageEmailSettings: true, canReadConversations: true, canCreateGroup: true, canCreateDirect: true, canUpload: true, canDownload: true, canViewOperationRecords: true }, members, conversations, files: [], invites: [], inviteSummary: { total: 0, active: 0, history: 0, acceptedUses: 0, availableUses: 0 }, eventCursor: 0 };

// Real production React views with synthetic API responses. This is not a Go integration test.
const assert = require('node:assert/strict');
const path = require('node:path');
const { expect } = require('@playwright/test');
const output = path.resolve(process.env.DUALLANE_UI_REVIEW_DIR || 'test-results/ui-refinement/topics-shared');
fs.mkdirSync(output, { recursive: true });
const base = process.env.DUALLANE_UI_BASE_URL || 'http://127.0.0.1:5186';
const topicTemplate = { id: 'topic-preview', conversationId: 'c1', title: '打磨每一次阅读与回复的细节', description: '集中确认导航、阅读位置和回复体验。每一种状态都应该清楚，让内容成为重点。', createdBy: 'u1', creator: members[0], status: 'open', joined: true, canJoin: false, allowSyncToGroup: true, revision: 1, participantCount: 2, notificationLevel: 'all', createdAt: now, updatedAt: now };
const emptyLibrary = { entries: [], collections: [], favorites: [], recent: [], emotes: [], usage: { itemCount: 0, subscribedItemCount: 0, totalBytes: 0, subscribedTotalBytes: 0, collectionCount: 0, subscribedCollectionCount: 0, overLimit: false }, limits: { maxItems: 100, maxTotalBytes: 10485760, maxInputBytes: 1048576, maxCollections: 10, maxCollectionItems: 100, maxBatchItems: 10 } };
async function geometry(page) {
  return page.evaluate(() => {
    const box = selector => { const e = document.querySelector(selector); const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return { x:r.x,y:r.y,width:r.width,height:r.height,padding:s.padding,fontSize:s.fontSize,lineHeight:s.lineHeight,borderRadius:s.borderRadius }; };
    return { pageWidth:document.documentElement.scrollWidth, viewportWidth:innerWidth, row:box('.workspace-message'), content:box('.workspace-message-content'), composer:box('.workspace-composer'), input:box('.workspace-lexical-editor'), send:box('.workspace-send-button'), list:box('.workspace-message-list') };
  });
}
(async () => {
  const browser = await chromium.launch({ headless:true });
  try {
    for (const width of [1440,390,320]) {
      const context = await browser.newContext({ viewport:{width,height:width === 1440 ? 1000 : 844}, hasTouch:width < 761, isMobile:width < 761 });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => { errors.push(error.message); console.error(error); });
      let topic = {...topicTemplate};
      const topicMessages = messages.map(m => ({...m,topicId:topic.id,author:members.find(u=>u.id===m.authorId)}));
      let projections = [];
      const attempts = [];
      const readRequests = [];
      let realtime;
      await page.routeWebSocket('**/ws/workspace', ws => { realtime=ws; ws.onMessage(() => ws.send(JSON.stringify({version:1,type:'ready',currentSeq:0,replayCount:0,hasMore:false}))); });
      await page.route('**/api/**', async route => {
        const url = new URL(route.request().url());
        const method = route.request().method();
        const isTopic = url.pathname.includes('/topics/' + topic.id);
        let data = {settings:{},preferences:{},collections:[],groups:[],emotes:[],topics:[topic],files:[],members,pins:[],messages:[],hasMore:false};
        let status = 200;
        if (url.pathname.endsWith('/bootstrap')) data=bootstrap;
        else if (isTopic && url.pathname.endsWith('/messages') && method==='POST') {
          const payload = route.request().postDataJSON(); attempts.push(payload);
          if (attempts.length===1) { status=503;data={error:{message:'模拟暂时不可用'}}; }
          else { const text=payload.content.blocks.map(b=>b.type==='mention'?'@'+b.label:b.text||'').join(''); const m={id:'topic-sent',clientMessageId:payload.clientMessageId,topicId:topic.id,authorId:'u1',authorKind:'human',author:members[0],content:{...payload.content,plainText:text},plainText:text,replyToMessageId:payload.replyToMessageId,createdAt:now};topicMessages.push(m);data={message:m};status=201; }
        }
        else if (isTopic && url.pathname.endsWith('/read')) {readRequests.push(route.request().postDataJSON().messageId);data={topicId:topic.id,unreadCount:0};}
        else if (isTopic && url.pathname.endsWith('/messages')) data={messages:topicMessages};
        else if (isTopic && url.pathname.endsWith('/members')) data={members:members.map(u=>({...u,userId:u.id}))};
        else if (isTopic && url.pathname.endsWith('/projections')) data={projections};
        else if (isTopic && url.pathname.endsWith('/sync')) { const id=url.pathname.split('/').at(-2);projections=method==='DELETE'?[]:[{id:'p1',topicMessageId:id}];data={projection:projections[0]||null}; }
        else if (isTopic && url.pathname.endsWith('/close')) {topic={...topic,status:'closed',revision:topic.revision+1};data={topic};}
        else if (isTopic && url.pathname.endsWith('/notification')) {topic={...topic,...route.request().postDataJSON()};data={topic};}
        else if (isTopic && url.pathname.endsWith('/join')) {topic={...topic,joined:true,canJoin:false};data={topic};}
        else if (url.pathname.endsWith('/topics/' + topic.id)) data={topic};
        else if (url.pathname.endsWith('/conversations/c1') || url.pathname.endsWith('/conversations/c1/read')) data={conversation:conversations[0]};
        else if (url.pathname.endsWith('/conversations')) data={conversations};
        else if (url.pathname.endsWith('/messages')) data={messages,hasMore:false};
        else if (url.pathname.endsWith('/members')) data={members};
        else if (url.pathname.endsWith('/me/emote-settings')) data={settings:{autoHideMessages:false,autoHideMessageTypes:[],clickImageEmoteToSend:false,replyAutoMention:true,enabledPackIds:['emoji'],minimumEnabled:1,availablePacks:[]}};
        else if (url.pathname.endsWith('/emote-library')) data=emptyLibrary;
        await route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
      });
      await page.goto(base+'/workspace/chat/c1',{waitUntil:'networkidle'});
      await expect(page.locator('.workspace-message')).toHaveCount(3).catch(async error=>{await page.screenshot({path:path.join(output,'failure.png')});console.error(await page.locator('body').innerText());throw error;});
      const groupGeometry=await geometry(page);
      await page.screenshot({path:path.join(output,`shared-group-${width}.png`)});
      await page.goto(base+'/workspace/topics/'+topic.id,{waitUntil:'networkidle'});
      await expect(page.locator('.workspace-topic-page .workspace-chat-panel')).toHaveCount(1);
      await expect(page.locator('.workspace-message')).toHaveCount(3);
      const topicGeometry=await geometry(page);
      for(const key of ['row','content','composer','input']) for(const property of ['padding','fontSize','lineHeight','borderRadius']) assert.equal(topicGeometry[key][property],groupGeometry[key][property],`${width} ${key}.${property}`);
      assert.ok(topicGeometry.pageWidth<=width,'page horizontal overflow');
      assert.ok(topicGeometry.list.height>170,'banner must leave a usable chat viewport');
      assert.ok(topicGeometry.composer.y+topicGeometry.composer.height<= (width===1440?1000:844),'composer stays in viewport');
      await expect(page.getByRole('button',{name:'添加附件',exact:true})).toBeEnabled();
      await expect(page.getByRole('button',{name:'显示格式工具栏',exact:true})).toBeVisible();
      await expect(page.getByTitle('提及成员',{exact:true})).toBeVisible();
      await page.screenshot({path:path.join(output,`shared-topic-${width}.png`)});
      const signalRefresh = seq => realtime.send(JSON.stringify({version:1,type:'events',events:[{id:'event-'+seq,seq,type:'topic.message.created',actorId:'u2',conversationId:'c1',targetType:'topic',targetId:topic.id,payload:{topicId:topic.id,conversationId:'c1'},createdAt:now}]}));
      const appendHistory = (id, index) => {const text='历史讨论 '+index+'，保留阅读位置与确认读游标。';topicMessages.push({...topicMessages[1],id,createdAt:new Date(Date.parse(now)+index*60000).toISOString(),plainText:text,content:{format:'blocks',plainText:text,blocks:[{type:'text',text}]}});};
      for(let index=0;index<20;index++) appendHistory('history-'+index,index+1);
      signalRefresh(1);
      await expect(page.locator('.workspace-message')).toHaveCount(23);
      const list=page.locator('.workspace-message-list');
      await list.evaluate(element=>{element.scrollTop=element.scrollHeight;});
      await expect.poll(()=>readRequests.includes('history-19')).toBe(true);
      await list.evaluate(element=>{element.scrollTop=0;});
      await expect(page.getByRole('button',{name:/回到最新消息|条新消息/})).toBeVisible();
      appendHistory('unread-button',30);signalRefresh(2);
      await expect(page.locator('.workspace-message')).toHaveCount(24);
      assert.equal(readRequests.includes('unread-button'),false,'reading history must not mark incoming messages');
      await page.getByRole('button',{name:/回到最新消息|条新消息/}).click();
      await expect.poll(()=>readRequests.includes('unread-button')).toBe(true);
      await list.evaluate(element=>{element.scrollTop=0;});
      await expect(page.getByRole('button',{name:/回到最新消息|条新消息/})).toBeVisible();
      appendHistory('unread-scroll',31);signalRefresh(3);
      await expect(page.locator('.workspace-message')).toHaveCount(25);
      assert.equal(readRequests.includes('unread-scroll'),false);
      await list.evaluate(element=>{element.scrollTop=element.scrollHeight;});
      await expect.poll(()=>readRequests.includes('unread-scroll')).toBe(true);
      assert.equal(readRequests.filter(id=>id==='unread-scroll').length,1,'a confirmed cursor is not posted repeatedly');
      const first = page.locator('.workspace-message').first();
      const more = first.getByTitle('更多消息操作',{exact:true});
      if(width<761){const hit=await more.boundingBox();assert.ok(hit.width>=44&&hit.height>=44);}
      await more.click();
      const menu=page.getByRole('menu',{name:'消息操作',exact:true});
      await expect(menu.getByRole('menuitem',{name:'同步到群聊',exact:true})).toBeEnabled();
      for (const name of ['撤回', '常驻', '表情回复', '隐藏']) await expect(menu.getByRole('menuitem',{name:new RegExp(name)})).toBeVisible();
      await menu.getByRole('menuitem',{name:'回复',exact:true}).click();
      const editor=page.getByRole('textbox',{name:'输入消息',exact:true});
      await expect(editor).toBeFocused();
      await expect(page.locator('.composer-reply')).toContainText(messages[0].plainText);
      await editor.fill('@');
      await expect(page.getByRole('dialog',{name:'提及成员',exact:true})).toBeVisible();
      await editor.press('Enter');
      await expect(editor).toContainText('@陈序');
      await editor.fill('**统一聊天** 😀');
      await page.getByRole('switch',{name:'同步到群聊',exact:true}).click();
      await page.getByTitle('发送消息',{exact:true}).click();
      await expect(page.locator('.message-local-state.failed')).toBeVisible();
      await editor.fill('保留较新的草稿');
      await page.locator('.message-local-state.failed').getByRole('button',{name:'重试发送',exact:true}).click();
      await expect(page.locator('.message-local-state.failed')).toHaveCount(0);
      assert.equal(attempts.length,2);assert.deepEqual(attempts[0],attempts[1]);assert.equal(attempts[0].syncToGroup,true);assert.equal(attempts[0].replyToMessageId,messages[0].id);
      await expect(editor).toHaveText('保留较新的草稿');
      await expect(page.locator('.workspace-message').filter({hasText:'统一聊天'}).locator('strong')).toContainText(['你','统一聊天']);
      await page.getByRole('button',{name:'话题详情',exact:true}).click();
      await page.getByRole('dialog',{name:'话题详情',exact:true}).getByRole('button',{name:'关闭话题',exact:true}).click();
      await page.getByRole('button',{name:'关闭话题详情',exact:true}).click();
      await expect(editor).toHaveAttribute('contenteditable','false');
      await expect(editor).toHaveText('保留较新的草稿');
      await expect(page.getByTitle('发送消息',{exact:true})).toBeDisabled();
      await expect(page.getByRole('switch',{name:'同步到群聊',exact:true})).toBeDisabled();
      assert.equal(errors.length,0,errors.join(';'));
      console.log(`${width}px: shared geometry, reply/mention, retry identity, newer draft, closed readonly, return/scroll read acknowledgement passed`);
      await context.close();
    }
    console.log('Screenshots:',output);
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
