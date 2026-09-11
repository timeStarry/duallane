const fs = require('fs');
const { chromium } = require('@playwright/test');
const now = '2026-09-11T09:15:00Z';
const members = [{ id: 'u1', githubLogin: 'lin', displayName: '林遥', kind: 'human', role: 'owner', joinedAt: now }, { id: 'u2', githubLogin: 'chen', displayName: '陈序', kind: 'human', role: 'member', joinedAt: now }];
const messages = ['新的设计语言已经更新到预览里了，导航和会话的边界更清楚。', '看到了，文件与话题也可以从这里直接进入。', '这次先集中确认阅读和回复体验，状态信息尽量保持轻量。'].map((text, i) => ({ id: 'm' + i, conversationId: 'c1', authorId: members[i % 2].id, authorName: members[i % 2].displayName, authorGithubLogin: members[i % 2].githubLogin, authorKind: 'human', kind: 'user', content: { format: 'blocks', plainText: text, blocks: [{ type: 'text', text }] }, plainText: text, createdAt: now, attachments: [], reactions: [] }));
const conversations = [{ id: 'c1', spaceId: 's1', type: 'group', title: '设计讨论', retentionCount: 1000, createdAt: now, lastActivityAt: now, messageCount: 3, memberCount: 2, lastMessagePlainText: messages[2].plainText, lastMessageAt: now, unreadCount: 2, notificationLevel: 'all', capabilities: { canSendMessage: true, canUploadFile: true, canManageMembers: true }, members, latestMessages: messages }, { id: 'c2', spaceId: 's1', type: 'direct', title: '陈序', retentionCount: 1000, createdAt: now, messageCount: 1, memberCount: 2, lastMessagePlainText: '待会儿见。', lastMessageAt: now, unreadCount: 0, notificationLevel: 'all', capabilities: { canSendMessage: true, canUploadFile: true }, members, latestMessages: [] }];
const bootstrap = { auth: { mode: 'github', inviteOnly: true, currentUser: members[0] }, space: { id: 's1', name: '青空工作室', slug: 'studio', createdBy: 'u1', createdAt: now }, policy: { dailyQuotaBytes: 1073741824, usedTodayBytes: 26214400, remainingQuotaBytes: 1047527424, messageRetentionCount: 1000, memberVisibilityBasis: 'direct_contacts' }, permissions: { canCreateMemberInvite: true, canCreatePrivilegedInvite: true, canManageMemberVisibility: true, canManageEmailSettings: true, canReadConversations: true, canCreateGroup: true, canCreateDirect: true, canUpload: true, canDownload: true, canViewOperationRecords: true }, members, conversations, files: [], invites: [], inviteSummary: { total: 0, active: 0, history: 0, acceptedUses: 0, availableUses: 0 }, eventCursor: 0 };
// Actual React pages with synthetic transport fixtures. This checks presentation, not Go integration.
const assert = require('node:assert/strict');
const path = require('node:path');
const { expect } = require('@playwright/test');
const output = path.resolve(process.env.DUALLANE_UI_REVIEW_DIR || 'test-results/ui-refinement/settings');
fs.mkdirSync(output, { recursive: true });
const topic = { id: 'topic-preview', conversationId: 'c1', title: '打磨每一次阅读与回复的细节', description: '把这次讨论集中在导航、阅读位置与回复体验。每一种状态都应该清楚、安静，让内容成为重点。', createdBy: 'u1', creator: members[0], status: 'open', joined: true, canJoin: false, allowSyncToGroup: true, revision: 1, participantCount: 2, notificationLevel: 'all', createdAt: now, updatedAt: now };
const topicMessages = messages.map(m => ({ ...m, topicId: topic.id, author: members.find(u => u.id === m.authorId), content: { ...m.content, format: 'duallane.message+json;v=1' } }));
if (process.env.UI_LAYOUT_LONG_TEXT === '1') {
    members[0].displayName = '林遥・一起把每一次交流做得更清楚也更从容';
    members[0].githubLogin = 'layout-verification-account-with-a-name';
    conversations[0].title = '设计讨论・关于跨平台阅读体验和个人偏好的一次完整讨论';
    topic.title = '关于跨平台阅读体验与个人偏好的一次完整讨论';
    topic.description += ' https://example.test/' + 'long-path-segment-'.repeat(12);
}
(async () => { const browser = await chromium.launch({ headless: true }); let captured = 0; try {
    for (const width of [1440, 390, 320])
        for (const section of ['profile', 'appearance', 'chat', 'notifications', 'email', 'push', 'privacy', 'emotes', 'home', 'topic', 'topics']) {
            if (process.env.UI_LAYOUT_WIDTH && String(width) !== process.env.UI_LAYOUT_WIDTH)
                continue;
            if (process.env.UI_LAYOUT_CASE && !section.includes(process.env.UI_LAYOUT_CASE))
                continue;
            const context = await browser.newContext({ viewport: { width, height: width === 1440 ? 1000 : 844 }, hasTouch: width < 761, isMobile: width < 761 });
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', error => { errors.push(error.message); console.error(section, width, error.stack); });
            await page.routeWebSocket('**/ws/workspace', ws => ws.onMessage(() => ws.send(JSON.stringify({ version: 1, type: 'ready', currentSeq: 0, replayCount: 0, hasMore: false }))));
            await page.route('**/api/**', async (route) => { const url = new URL(route.request().url()); let data = { settings: {}, preferences: {}, collections: [], groups: [], emotes: [], topics: [topic], files: [], members, pins: [], messages: [], hasMore: false }; if (url.pathname.endsWith('/bootstrap'))
                data = bootstrap;
            else if (url.pathname.endsWith('/conversations'))
                data = { conversations };
            else if (url.pathname.includes('/topics/' + topic.id + '/messages'))
                data = { messages: topicMessages };
            else if (url.pathname.endsWith('/topics/' + topic.id + '/members'))
                data = { members: members.map(u => ({ ...u, userId: u.id })) };
            else if (url.pathname.endsWith('/topics/' + topic.id + '/projections'))
                data = { projections: [] };
            else if (url.pathname.endsWith('/topics/' + topic.id))
                data = { topic };
            else if (url.pathname.endsWith('/members'))
                data = { members };
            else if (url.pathname.endsWith('/me/emote-settings'))
                data = { settings: { autoHideMessages: true, autoHideMessageTypes: ['image', 'emote', 'long'], clickImageEmoteToSend: false, replyAutoMention: true, enabledPackIds: ['classic', 'people'], minimumEnabled: 1, availablePacks: [{ id: 'classic', label: '经典表情' }, { id: 'people', label: '人物与生活' }, { id: 'animals', label: '动物与自然' }] } };
            else if (url.pathname.endsWith('/me/notifications'))
                data = { notifications: { enabled: true, maskedEmail: 'l***@example.test', emailSource: 'github', emailVerified: true, githubEmail: 'layout@example.test', immediateEnabled: false, digestEnabled: true, mailAvailable: true } };
            else if (url.pathname.endsWith('/me/ntfy'))
                data = { ntfy: { enabled: true, topic: 'synthetic-layout-preview', serverUrl: 'https://push.example.test', subscriptionUrl: 'https://push.example.test/synthetic-layout-preview', createdAt: now, updatedAt: now } };
            else if (url.pathname.endsWith('/emote-library'))
                data = { entries: [], collections: [], favorites: [], recent: [], emotes: [], usage: { itemCount: 0, subscribedItemCount: 0, totalBytes: 0, subscribedTotalBytes: 0, collectionCount: 0, subscribedCollectionCount: 0, overLimit: false }, limits: { maxItems: 100, maxTotalBytes: 10485760, maxInputBytes: 1048576, maxCollections: 10, maxCollectionItems: 100, maxBatchItems: 10 } }; await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) }); });
            const routeName = section === 'topic' ? '/workspace/topics/' + topic.id : section === 'topics' ? '/workspace/topics' : '/workspace/account' + (section === 'home' ? '' : section === 'email' || section === 'push' ? '/notifications/' + section : '/' + section);
            await page.goto((process.env.DUALLANE_UI_BASE_URL || 'http://127.0.0.1:5186') + routeName, { waitUntil: 'networkidle' });
            await page.locator('.workspace-shell').waitFor();
            if (section === 'appearance') {
                await expect(page.locator('.dl-theme-card')).toHaveCount(5);
                await page.getByRole('button', { name: '暮色主题', exact: true }).focus();
                await page.keyboard.press('Enter');
                await expect(page.locator('html')).toHaveAttribute('data-theme-family', 'dusk');
                await page.getByRole('button', { name: '原色主题', exact: true }).click();
                await expect(page.locator('html')).toHaveAttribute('data-theme-family', 'original');
                await page.getByRole('radiogroup', { name: '显示模式', exact: true }).getByRole('radio', { name: '深色', exact: true }).click();
                await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
                await expect(page.locator('.dl-theme-preview').first()).toHaveCSS('background-color', 'rgb(21, 27, 32)');
                await page.screenshot({ path: path.join(output, 'appearance-' + width + '-dark.png') });
                await page.getByRole('radiogroup', { name: '显示模式', exact: true }).getByRole('radio', { name: '浅色', exact: true }).click();
                await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
                assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('duallane-appearance')).mode), 'light');
            }
            const geometry = await page.evaluate(() => { const pane = document.querySelector('.dl-settings-pane'); const status = document.querySelector('.workspace-topic-page .workspace-topic-status'); return { width: innerWidth, scrollWidth: document.documentElement.scrollWidth, paneWidth: pane?.clientWidth, paneScrollWidth: pane?.scrollWidth, statusWidth: status?.getBoundingClientRect().width }; });
            assert.equal(errors.length, 0, errors.join(';'));
            assert.ok(geometry.scrollWidth <= width, section + ' page overflow');
            if (!['home', 'topic', 'topics'].includes(section))
                assert.ok(geometry.paneWidth > 0, section + ' pane must be visible');
            if (section !== 'home' && geometry.paneWidth)
                assert.ok(geometry.paneScrollWidth <= geometry.paneWidth + 1, section + ' pane overflow');
            if (section === 'topic') {
                assert.ok(geometry.statusWidth > 0 && geometry.statusWidth < 96, 'status must hug its label');
                await expect(page.getByTitle('发送消息', { exact: true })).toBeDisabled();
                const sendBounds = await page.getByTitle('发送消息', { exact: true }).boundingBox();
                const minimumSendTarget = width < 761 ? 44 : 36;
                assert.ok(sendBounds && sendBounds.width >= minimumSendTarget && sendBounds.height >= minimumSendTarget, 'shared send target remains visible: ' + JSON.stringify(sendBounds));
            }
            await page.screenshot({ path: path.join(output, section + '-' + width + '.png') });
            if (['chat', 'email', 'appearance'].includes(section)) {
                await page.locator('.dl-settings-pane').evaluate(e => e.scrollTop = e.scrollHeight);
                await page.screenshot({ path: path.join(output, section + '-' + width + '-bottom.png') });
            }
            if (section === 'push') {
                await page.getByRole('button', { name: /配置 ntfy 客户端/ }).click();
                const help = page.getByRole('dialog', { name: '订阅 ntfy 通知', exact: true });
                await expect(help).toBeVisible();
                assert.ok(await help.evaluate(element => element.scrollWidth <= element.clientWidth), 'push instructions overflow');
                await page.screenshot({ path: path.join(output, 'push-help-' + width + '.png'), animations: 'disabled' });
                await page.getByRole('button', { name: '关闭 ntfy 使用说明', exact: true }).click();
            }
            console.log(section, width, JSON.stringify(geometry));
            captured++;
            await context.close();
        }
    console.log('Layout cases passed:', captured, 'Screenshots:', output);
}
finally {
    await browser.close();
} })();
