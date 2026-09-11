(() => {
  const byId = id => document.getElementById(id);
  const text = escapeHtml;
  const menu = byId('ux-context-menu');
  const sheet = byId('ux-action-sheet');
  const confirm = byId('ux-confirm');
  const list = byId('ux-object-list');
  const feedback = message => { byId('ux-feedback').textContent = message; };
  const originals = [
    { id: 'lin', author: '小林', body: '周末去山里走走吧。\n找个信号不太好的地方，慢慢过两天。', self: false, kind: 'message' },
    { id: 'self', author: '你', body: '周六 09:00 在车站集合。\n我把路线放在这里，大家有空再看。', self: true, kind: 'message' },
    { id: 'file', author: '你', body: '周末计划.txt', self: true, kind: 'file' }
  ];
  let objects = structuredClone(originals);
  let presentation = 'auto';
  let opened = null;
  let gesture = null;
  let suppressedClick = null;
  let modalReturn = null;
  let modalAction = null;
  let profileLeave = null;
  function renderObjects() {
    list.innerHTML = objects.map(object => `<article class="ux-object ${object.self ? 'self' : ''}" data-object="${object.id}" tabindex="0" aria-label="${object.author}的${object.kind === 'file' ? '文件' : '消息'}操作区域">
      <div class="ux-object-meta"><strong>${object.author}</strong><span>09:41${object.kind === 'file' ? ' · 分享的文件' : ''}</span>${object.pinned ? '<span class="pill">常驻</span>' : ''}</div>
      ${object.hidden ? '<p class="muted">已对自己隐藏</p><button class="btn quiet" data-restore="' + object.id + '">恢复显示</button>' : object.recalled || object.removed ? '<p class="muted">' + (object.recalled ? '你撤回了一条消息' : '此示例文件已移除') + '</p>' : object.kind === 'file' ? `<div class="ux-file">${icon('FileText')}<div><strong class="ux-text">${text(object.body)}</strong><small>2 KB · 已保存到空间</small></div></div>` : `<p class="ux-text">${text(object.body)}</p>`}
      ${!object.hidden && !object.recalled && !object.removed ? `<button type="button" class="ux-more" data-more="${object.id}" aria-label="${object.author}的${object.kind === 'file' ? '文件' : '消息'}更多操作" aria-haspopup="menu" aria-expanded="false">${icon('MoreHorizontal')}</button>` : ''}
      <div class="ux-object-hint">${object.kind === 'message' ? '右键或长按这片空白 · 也可点更多' : '文件也有自己的操作菜单'}</div>
    </article>`).join('');
  }
  const actionsFor = object => object.kind === 'file' ? [
    { id: 'download', label: '下载文件', glyph: 'Download' },
    { id: 'source', label: '查看来源会话', glyph: 'MessageCircle' },
    { id: 'remove', label: '移除文件', glyph: 'Trash2', danger: true }
  ] : [
    { id: 'reply', label: '回复', glyph: 'Reply' },
    { id: 'copy', label: '复制消息', glyph: 'Copy' },
    ...(object.self ? [{ id: 'pin', label: object.pinned ? '取消常驻' : '设为常驻消息', glyph: 'Pin' }] : []),
    { id: 'hide', label: '对自己隐藏', glyph: 'EyeOff', hint: '仅自己', divider: true },
    ...(object.self ? [{ id: 'recall', label: '撤回消息', glyph: 'Undo2', danger: true }] : [])
  ];
  function menuItems(object) {
    return actionsFor(object).map(action => `${action.divider || action.danger ? '<div class="ux-menu-divider" role="separator"></div>' : ''}<button class="ux-menu-item ${action.danger ? 'danger' : ''}" role="menuitem" type="button" data-ux-action="${action.id}">${icon(action.glyph)}<span>${action.label}</span>${action.hint ? `<small>${action.hint}</small>` : ''}</button>`).join('');
  }
  function closeActions(restore = true) {
    if (!opened) return;
    const previous = opened;
    opened = null;
    menu.hidden = true;
    if (sheet.open) sheet.close();
    document.querySelectorAll('.ux-object.is-target').forEach(element => element.classList.remove('is-target'));
    previous.trigger?.setAttribute('aria-expanded', 'false');
    if (restore && previous.trigger?.isConnected) previous.trigger.focus({ preventScroll: true });
  }
  function openActions(id, trigger, point, pointerType) {
    const object = objects.find(item => item.id === id);
    if (!object || object.hidden || object.recalled || object.removed || confirm.open) return;
    closeActions(false);
    const isSheet = presentation === 'phone' || (presentation === 'auto' && (innerWidth <= 760 || pointerType === 'touch'));
    const anchor = trigger.getBoundingClientRect();
    opened = { id, trigger, isSheet, anchorX: anchor.x, anchorY: anchor.y, scrollX, scrollY };
    trigger.setAttribute('aria-expanded', 'true');
    list.querySelector(`[data-object="${id}"]`).classList.add('is-target');
    if (isSheet) {
      sheet.innerHTML = `<div class="ux-sheet-head"><h3 id="ux-sheet-title">${object.kind === 'file' ? '文件操作' : '消息操作'}</h3><button type="button" class="btn quiet" data-close-actions>关闭</button></div><div class="ux-sheet-preview"><strong>${object.author}</strong><br>${text(object.body)}</div><div role="menu" aria-label="${object.kind === 'file' ? '文件' : '消息'}可用操作">${menuItems(object)}</div>`;
      sheet.showModal();
      sheet.querySelector('[role=menuitem]').focus();
    } else {
      menu.innerHTML = `<div class="ux-menu-caption">${object.author} · ${object.kind === 'file' ? text(object.body) : '共享空间消息'}</div>${menuItems(object)}`;
      menu.hidden = false;
      const bounds = trigger.getBoundingClientRect();
      const x = point?.x ?? bounds.left;
      const y = point?.y ?? bounds.bottom;
      const viewport = window.visualViewport;
      const left = viewport?.offsetLeft ?? 0;
      const top = viewport?.offsetTop ?? 0;
      const right = left + (viewport?.width ?? innerWidth);
      const bottom = top + (viewport?.height ?? innerHeight);
      menu.style.left = `${Math.max(left + 12, Math.min(x, right - menu.offsetWidth - 12))}px`;
      menu.style.top = `${Math.max(top + 12, Math.min(y, bottom - menu.offsetHeight - 12))}px`;
      menu.querySelector('[role=menuitem]').focus({ preventScroll: true });
    }
  }
  function showConfirm({ title, body, label = '确认', danger = false, action, trigger, extra = '' }) {
    closeActions(false);
    modalReturn = trigger ?? document.activeElement;
    modalAction = action;
    confirm.innerHTML = `<h3 id="ux-confirm-title">${title}</h3><p>${body}</p>${extra}<div class="button-row"><button class="btn" type="button" data-confirm-cancel>取消</button><button class="btn ${danger ? 'ux-danger' : 'primary'}" type="button" data-confirm-accept>${label}</button></div>`;
    confirm.showModal();
    confirm.querySelector('[data-confirm-cancel]').focus();
  }
  confirm.addEventListener('click', event => {
    if (event.target.closest('[data-confirm-cancel]')) { profileLeave = null; modalAction = null; confirm.close(); }
    if (event.target.closest('[data-confirm-accept]')) {
      const action = modalAction;
      modalAction = null;
      confirm.close();
      action?.();
    }
  });
  confirm.addEventListener('close', () => {
    // Native close events are queued; an older dialog must not clear a reopened one.
    if (confirm.open) return;
    modalAction = null;
    if ((document.activeElement === document.body || confirm.contains(document.activeElement)) && modalReturn?.isConnected) modalReturn.focus({ preventScroll: true });
  });
  confirm.addEventListener('cancel', () => { profileLeave = null; modalAction = null; });
  function modalKeyboard(event) {
    event.stopPropagation();
    if (event.key !== 'Tab') return;
    const focusable = [...event.currentTarget.querySelectorAll('button:not(:disabled),textarea,input,select,a[href]')].filter(element => element.getClientRects().length);
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  confirm.addEventListener('keydown', modalKeyboard);
  async function performAction(actionId) {
    const current = opened;
    if (!current) return;
    const object = objects.find(item => item.id === current.id);
    if (!actionsFor(object).some(action => action.id === actionId)) return;
    closeActions();
    if (actionId === 'reply') {
      byId('ux-reply').hidden = false;
      byId('ux-reply').innerHTML = `<span>回复 ${object.author}：${text(object.body.slice(0, 24))}</span><button type="button" class="btn quiet" id="ux-cancel-reply">取消回复</button>`;
      byId('ux-cancel-reply').onclick = () => { byId('ux-reply').hidden = true; byId('ux-draft').focus(); };
      byId('ux-draft').focus();
      feedback(`已选中${object.author}的消息作为回复对象；草稿仍属于当前会话。`);
    } else if (actionId === 'copy') {
      try { await navigator.clipboard.writeText(object.body); feedback('已复制这条示例消息。'); }
      catch { showConfirm({ title: '复制消息', body: '可以选择下方文字，使用系统复制操作。', label: '完成', trigger: current.trigger, extra: `<textarea aria-label="要复制的消息" readonly>${text(object.body)}</textarea>` }); }
    } else if (actionId === 'pin') {
      object.pinned = !object.pinned; renderObjects();
      list.querySelector(`[data-more="${object.id}"]`).focus({ preventScroll: true });
      feedback(object.pinned ? '此示例消息已设为群常驻；不等于会话置顶。' : '已取消此示例消息的常驻。');
    } else if (actionId === 'hide') {
      object.hidden = true; renderObjects(); list.querySelector(`[data-restore="${object.id}"]`).focus({ preventScroll: true });
      feedback('仅对自己隐藏；可以在原位置恢复，其他成员的消息不受影响。');
    } else if (actionId === 'recall' || actionId === 'remove') {
      const recall = actionId === 'recall';
      showConfirm({ title: recall ? '撤回这条消息？' : '移除这个文件？', body: recall ? '共享会话中会显示撤回状态。此草稿只修改本页样例。' : `“${text(object.body)}”将从本页样例中移除。真实产品仍须校验文件权限。`, label: recall ? '撤回消息' : '移除文件', danger: true, trigger: current.trigger, action: () => {
        object[recall ? 'recalled' : 'removed'] = true; renderObjects();
        list.querySelector(`[data-object="${object.id}"]`).focus({ preventScroll: true });
        feedback(recall ? '已撤回本页示例消息。' : '已移除本页示例文件。');
      } });
    } else if (actionId === 'download') { downloadSample(); feedback('已下载本地生成的示例文件。'); }
    else if (actionId === 'source') { list.querySelector('[data-object=self]').focus(); feedback('来源会话：山间周末。已定位到这段示例讨论。'); }
  }
  function actionClick(event) {
    const action = event.target.closest('[data-ux-action]');
    if (action) void performAction(action.dataset.uxAction);
    if (event.target.closest('[data-close-actions]')) closeActions();
  }
  function actionKeyboard(event) {
    const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
    if (keys.includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      const items = [...event.currentTarget.querySelectorAll('[role=menuitem]')];
      const current = items.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    } else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeActions(); }
    else if (event.key === 'Tab' && event.currentTarget === menu) closeActions();
  }
  menu.addEventListener('click', actionClick); sheet.addEventListener('click', actionClick);
  menu.addEventListener('keydown', actionKeyboard); sheet.addEventListener('keydown', actionKeyboard); sheet.addEventListener('keydown', modalKeyboard);
  sheet.addEventListener('cancel', event => { event.preventDefault(); closeActions(); });
  sheet.addEventListener('click', event => { if (event.target === sheet) { const r = sheet.getBoundingClientRect(); if (event.clientY < r.top || event.clientX < r.left || event.clientX > r.right) closeActions(); } });
  const nativeTarget = target => target.closest('.ux-text,a,input,textarea,select,[contenteditable=true]');
  list.addEventListener('contextmenu', event => {
    const object = event.target.closest('[data-object]');
    if (!object || nativeTarget(event.target) || window.getSelection()?.toString()) return;
    event.preventDefault();
    if (opened?.id === object.dataset.object) return;
    openActions(object.dataset.object, object.querySelector('[data-more]') ?? object, { x: event.clientX, y: event.clientY }, event.pointerType);
  });
  list.addEventListener('click', event => {
    if (suppressedClick && performance.now() < suppressedClick.until && event.target.closest('[data-object]')?.dataset.object === suppressedClick.id) { event.preventDefault(); event.stopPropagation(); return; }
    const more = event.target.closest('[data-more]');
    if (more) openActions(more.dataset.more, more);
    const restore = event.target.closest('[data-restore]');
    if (restore) { objects.find(item => item.id === restore.dataset.restore).hidden = false; renderObjects(); list.querySelector(`[data-more="${restore.dataset.restore}"]`).focus(); feedback('已恢复本页消息显示。'); }
  });
  list.addEventListener('keydown', event => {
    if (!(event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) || nativeTarget(event.target)) return;
    const object = event.target.closest('[data-object]');
    if (object) { event.preventDefault(); openActions(object.dataset.object, object.querySelector('[data-more]') ?? object); }
  });
  function cancelGesture() { if (gesture) clearTimeout(gesture.timer); gesture = null; }
  document.addEventListener('pointerdown', event => {
    if (gesture && event.pointerId !== gesture.pointerId) cancelGesture();
    if (opened && !opened.isSheet && !menu.contains(event.target) && !event.target.closest('[data-more]')) closeActions(false);
  }, true);
  list.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'touch' || !event.isPrimary || event.button !== 0 || nativeTarget(event.target) || event.target.closest('button')) return;
    const target = event.target.closest('[data-object]');
    if (!target || window.getSelection()?.toString()) return;
    cancelGesture();
    gesture = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, target, timer: null };
    gesture.timer = setTimeout(() => {
      if (!gesture || !target.isConnected) return;
      suppressedClick = { id: target.dataset.object, until: performance.now() + 900 };
      openActions(target.dataset.object, target.querySelector('[data-more]') ?? target, null, 'touch');
      cancelGesture();
    }, 450);
  });
  document.addEventListener('pointermove', event => { if (gesture && event.pointerId === gesture.pointerId && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 10) cancelGesture(); }, { passive: true });
  document.addEventListener('pointerup', cancelGesture, { passive: true });
  document.addEventListener('pointercancel', cancelGesture, { passive: true });
  document.addEventListener('scroll', event => {
    cancelGesture();
    if (!opened || opened.isSheet || menu.contains(event.target)) return;
    const anchor = opened.trigger.getBoundingClientRect();
    // An already queued scroll notification from before opening is not a new scroll.
    if (Math.abs(anchor.x - opened.anchorX) > 0.5 || Math.abs(anchor.y - opened.anchorY) > 0.5 || scrollX !== opened.scrollX || scrollY !== opened.scrollY) closeActions(false);
  }, true);
  window.addEventListener('blur', () => { cancelGesture(); closeActions(false); });
  window.addEventListener('resize', () => { cancelGesture(); closeActions(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { cancelGesture(); closeActions(false); } });
  byId('ux-presentation').onclick = event => { const button = event.target.closest('[data-presentation]'); if (!button) return; closeActions(); presentation = button.dataset.presentation; byId('ux-presentation').querySelectorAll('button').forEach(item => item.setAttribute('aria-pressed', String(item === button))); };
  byId('ux-reset').onclick = () => { closeActions(false); objects = structuredClone(originals); renderObjects(); byId('ux-reply').hidden = true; feedback('已重置消息样例，输入草稿保留。'); };
  renderObjects();

  const categories = [
    ['profile', '个人资料', 'UserRound'], ['appearance', '外观', 'Palette'], ['chat', '聊天', 'MessageCircle'],
    ['notifications', '通知', 'Bell'], ['privacy', '隐私', 'Shield'], ['emotes', '表情', 'Smile'], ['bot', 'Bot 与连接', 'Bot']
  ];
  const pane = byId('prefs-pane'), nav = byId('prefs-nav'), shell = byId('prefs-shell');
  const allowedRoutes = ['home', ...categories.map(item => item[0]), 'notifications/email', 'notifications/push', 'bot/connection'];
  const initialQuery = new URL(location.href).searchParams.get('settings');
  let route = allowedRoutes.includes(initialQuery) ? initialQuery : innerWidth <= 760 ? 'home' : 'appearance';
  let routeIndex = 0, restoringPop = false, allowPop = false, pendingPopPrompt = null;
  history.replaceState({ ...history.state, dlPrefsRoute: route, dlPrefsIndex: 0 }, '');
  const scrolls = new Map();
  const values = { email: true, push: false, discoverable: true, mentionReply: true, directEmote: false, frequency: 'digest', botPaused: false };
  const saves = new Map();
  let failNext = false;
  let savedName = '小林', draftName = savedName;
  const profileDirty = () => draftName.trim() !== savedName;
  const rootCategory = value => value.split('/')[0];
  const titleFor = value => ({ home: '个人设置', 'notifications/email': '邮件通知', 'notifications/push': '手机推送', 'bot/connection': '连接与授权' }[value] ?? categories.find(item => item[0] === value)?.[1] ?? '个人设置');
  function stateMarkup(key) {
    const save = saves.get(key);
    const label = !save ? '' : save.state === 'saving' ? '正在保存到本页…' : save.state === 'error' ? '保存失败，修改已保留。' : '已在本页保存';
    return `<div class="prefs-save-status" data-save-status="${key}" data-state="${save?.state ?? 'idle'}" role="status">${label}${save?.state === 'error' ? `<button class="prefs-retry" type="button" data-retry="${key}">重试</button>` : ''}</div>`;
  }
  function refreshStatus(key) {
    const element = pane.querySelector(`[data-save-status="${key}"]`);
    if (element) {
      const hadFocus = element.contains(document.activeElement);
      const template = document.createElement('template'); template.innerHTML = stateMarkup(key);
      const replacement = template.content.firstElementChild;
      replacement.tabIndex = -1;
      element.replaceWith(replacement);
      if (hadFocus) replacement.focus({ preventScroll: true });
    }
    updateProfileActions();
    if (key === 'profile' && confirm.open && profileLeave) {
      const save = saves.get(key);
      const status = confirm.querySelector('[data-leave-status]');
      if (status) status.textContent = save?.state === 'error' ? '保存失败，资料仍保留。请重试或继续编辑。' : save?.state === 'saving' ? '正在保存，成功后再离开…' : '';
      const button = confirm.querySelector('[data-save-leave]');
      if (button) button.disabled = save?.state === 'saving';
    }
  }
  function savePreference(key, value, onSuccess) {
    values[key] = value;
    const revision = (saves.get(key)?.revision ?? 0) + 1;
    const fails = failNext; failNext = false;
    byId('prefs-fail-next').setAttribute('aria-pressed', 'false');
    byId('prefs-fail-next').textContent = '模拟下一次保存失败';
    saves.set(key, { revision, state: 'saving', value, onSuccess }); refreshStatus(key);
    setTimeout(() => {
      if (saves.get(key)?.revision !== revision) return;
      saves.set(key, { revision, state: fails ? 'error' : 'saved', value, onSuccess });
      if (!fails) onSuccess?.(value);
      refreshStatus(key);
    }, 480);
  }
  const switchRow = (key, label, description) => `<div class="prefs-setting-row"><div><strong id="prefs-label-${key}">${label}</strong><p>${description}</p></div><button type="button" class="switch" role="switch" data-pref="${key}" aria-checked="${values[key]}" aria-labelledby="prefs-label-${key}"></button></div>${stateMarkup(key)}`;
  const leafRow = (target, label, description) => `<button type="button" class="prefs-leaf-row" data-route="${target}"><span><strong>${label}</strong><small>${description}</small></span>${icon('ChevronRight')}</button>`;
  function renderNav() {
    nav.innerHTML = `<h3 class="prefs-home-title">个人设置</h3><div class="prefs-identity"><span class="avatar">林</span><div><strong id="prefs-identity-name">${text(savedName)}</strong><small>个人偏好 · 仅影响自己</small></div></div><div class="prefs-nav-caption">偏好与账号</div>${categories.map(([id, label, glyph], index) => `${index === 5 ? '<div class="prefs-nav-caption">个人扩展</div>' : ''}<button type="button" class="prefs-category" data-route="${id}" ${rootCategory(route) === id ? 'aria-current="page"' : ''}>${icon(glyph)}<span>${label}</span>${icon('ChevronRight').replace('class="', 'class="prefs-category-arrow ')}</button>`).join('')}`;
  }
  function renderPane() {
    shell.dataset.page = route; renderNav();
    const parent = route.includes('/') ? rootCategory(route) : 'home';
    const heading = `<header class="prefs-page-header"><div class="prefs-breadcrumb">${route !== 'home' ? `<button type="button" class="prefs-back" data-route="${parent}">${icon('ArrowLeft')}${titleFor(parent)}</button><span>/</span>` : ''}<span>${titleFor(route)}</span></div><h3 tabindex="-1" id="prefs-title">${titleFor(route)}</h3></header>`;
    let content = '';
    if (route === 'home') content = '<p class="prefs-summary">选择一个分类，调整属于自己的使用习惯。</p>' + categories.map(([id, label]) => leafRow(id, label, '查看与调整')).join('');
    if (route === 'profile') content = `<p class="prefs-summary">别人会在会话和成员列表中看到你的资料。</p><label class="prefs-field"><span>显示名称</span><input id="prefs-name" value="${text(draftName)}" maxlength="40" autocomplete="off"><small>新流程：编辑后明确保存；离开前可继续编辑或放弃修改。</small></label><div class="prefs-setting-row"><div><strong>登录身份</strong><p>GitHub · @xiaolin-demo</p></div><span class="small muted">只读</span></div><div class="prefs-profile-actions">${stateMarkup('profile')}<div class="button-row"><button type="button" class="btn" id="prefs-discard">恢复原值</button><button type="button" class="btn primary" id="prefs-save-profile">保存资料</button></div></div>`;
    if (route === 'appearance') content = `<p class="prefs-summary">改变色彩与手感，保留熟悉的位置和操作。</p><div class="prefs-group"><h4>主题</h4><div class="prefs-themes">${Object.entries(THEME_REGISTRY.themes).map(([id, theme]) => `<button type="button" class="prefs-theme" data-pref-family="${id}" aria-pressed="false"><span class="prefs-colors"><i></i><i></i></span><strong>${theme.name}</strong><small>${id === 'original' ? '铜橙 · 青蓝' : id === 'grove' ? '莓红 · 松绿' : '赭金 · 靛紫'}</small></button>`).join('')}</div>${stateMarkup('theme')}</div><div class="prefs-group"><h4>显示模式</h4><div class="segmented" aria-label="设置中的显示模式">${[['light','浅色'],['dark','深色'],['system','随系统']].map(([id,label]) => `<button type="button" data-pref-mode="${id}" aria-pressed="false">${label}</button>`).join('')}</div>${stateMarkup('mode')}</div><div class="prefs-group"><h4>内容密度</h4><div class="segmented" aria-label="设置中的内容密度"><button type="button" data-pref-density="comfortable" aria-pressed="false">舒适</button><button type="button" data-pref-density="compact" aria-pressed="false">紧凑</button></div>${stateMarkup('density')}</div>${switchRow('motion','动态反馈','跟随系统的减少动态效果偏好。')}${switchRow('transparency','透明材质','关闭后使用清晰的实色底面。')}`;
    if (route === 'chat') content = `<p class="prefs-summary">设置自己的编辑习惯；群聊和话题保持相同规则。</p>${switchRow('mentionReply','回复时提及对方','只在当前会话支持提及时应用。')}${switchRow('directEmote','点击表情直接发送','开启后，选择表情会直接发送；关闭时加入草稿。')}<div class="prefs-group"><h4>消息显示</h4><p class="prefs-summary">个人隐藏与撤回不同：隐藏只改变自己看到的内容，不删除共享消息，也不影响其他成员。完整分类规则由正式应用承接。</p></div>`;
    if (route === 'notifications') content = `<p class="prefs-summary">选择接收提醒的渠道。会话和话题的免打扰仍独立生效。</p>${leafRow('notifications/email', '邮件通知', values.email ? '已开启 · 已验证邮箱 · 不含消息正文' : '已关闭 · 保留邮箱设置')}${leafRow('notifications/push','手机推送',values.push ? '已开启 · 通过 ntfy 接收' : '未开启 · 通过 ntfy 客户端接收')}<p class="prefs-summary">此草稿不会请求系统通知权限，也不会发送外部消息。</p>`;
    if (route === 'notifications/email') content = `<p class="prefs-summary">重要提醒发送到已验证的邮箱；通知不包含消息正文。</p>${switchRow('email','接收邮件通知','关闭渠道不会修改群聊或话题的提醒级别。')}<div class="prefs-setting-row"><div><strong>接收邮箱</strong><p>li***@example.com</p></div><span class="pill success">示例已验证</span></div><div class="prefs-setting-row"><div><strong>提醒频率</strong><p>设置当前邮件渠道的节奏。</p></div><select id="prefs-frequency" aria-label="邮件提醒频率"><option value="instant">即时</option><option value="digest">汇总</option></select></div>${stateMarkup('frequency')}`;
    if (route === 'notifications/push') content = `<p class="prefs-summary">通过 ntfy 客户端接收手机推送，与浏览器通知授权分开。</p>${switchRow('push','接收手机推送','这里只预览开关与保存反馈，不连接真实渠道。')}<div class="prefs-group"><h4>客户端配置</h4><p class="prefs-summary">正式配置会提供当前空间的地址和专属订阅信息。敏感配置只在授权界面展示。</p><button type="button" class="btn" data-demo-command="push-help">查看配置步骤</button></div>`;
    if (route === 'privacy') content = `<p class="prefs-summary">明确自己的可发现范围，已有关系继续由空间权限管理。</p>${switchRow('discoverable','允许成员搜索到我','关闭不删除已有会话或联系人，也不修改空间的成员可见范围。')}`;
    if (route === 'emotes') content = `<p class="prefs-summary">表情管理使用完整内容页承载，选择器仍服务于当前编辑器。</p><div class="prefs-setting-row"><div><strong>我的表情</strong><p>收藏、合集、上传和订阅归在同一个个人工具中。</p></div>${icon('Smile')}</div><div class="prefs-setting-row"><div><strong>订阅与独立副本</strong><p>订阅跟随作者更新，独立副本由自己管理。</p></div>${icon('FolderClosed')}</div><p class="prefs-summary">本页展示入口归属，完整表情库沿用全页面覆盖账本的实施要求。</p>`;
    if (route === 'bot') content = `<p class="prefs-summary">管理自己的 Bot。触发消息与读取上下文是不同授权。</p><div class="prefs-identity"><span class="avatar bot">${icon('Bot')}</span><div><strong>山间助手</strong><small>个人 Bot · 示例身份</small></div></div>${leafRow('bot/connection','连接与授权','连接状态、授权范围与凭据分别查看')}${switchRow('botPaused','暂停 Bot','暂停后停止处理新触发；不会永久停用或撤销身份。')}`;
    if (route === 'bot/connection') content = `<p class="prefs-summary">凭据操作与普通偏好分开，不会因为切换开关自动生成或轮换。</p><div class="prefs-setting-row"><div><strong>连接状态</strong><p>此样例没有连接外部运行时。</p></div><span class="pill">未连接</span></div><div class="prefs-setting-row"><div><strong>上下文访问</strong><p>按具体会话明确授权；创建私聊不等于允许读取历史。</p></div>${icon('Shield')}</div><div class="prefs-group"><h4>凭据</h4><button class="btn" type="button" data-demo-command="rotate">查看轮换确认样例</button><p class="prefs-summary">不生成、不复制真实 Token。正式操作需要服务端授权与审计。</p></div>`;
    pane.innerHTML = heading + content;
    if (byId('prefs-frequency')) byId('prefs-frequency').value = values.frequency;
    syncAppearance(); updateProfileActions();
    pane.scrollTop = scrolls.get(route) ?? 0;
  }
  function updateProfileActions() {
    const save = byId('prefs-save-profile');
    if (save) { save.disabled = !profileDirty() || !draftName.trim() || saves.get('profile')?.state === 'saving'; byId('prefs-discard').disabled = !profileDirty() || saves.get('profile')?.state === 'saving'; }
    const status = pane.querySelector('[data-save-status=profile]');
    if (status && profileDirty() && !['saving','error'].includes(saves.get('profile')?.state)) {
      status.textContent = '有未保存的修改'; status.dataset.state = 'dirty';
    }
    const identity = byId('prefs-identity-name'); if (identity) identity.textContent = savedName;
  }
  function syncAppearance() {
    const root = document.documentElement;
    pane.querySelectorAll('[data-pref-family]').forEach(button => {
      const colors = THEME_REGISTRY.themes[button.dataset.prefFamily][root.dataset.theme];
      button.setAttribute('aria-pressed', String(button.dataset.prefFamily === root.dataset.family));
      const swatches = button.querySelectorAll('i'); swatches[0].style.background = colors.direct; swatches[1].style.background = colors.shared;
    });
    pane.querySelectorAll('[data-pref-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.prefMode === selectedMode)));
    pane.querySelectorAll('[data-pref-density]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.prefDensity === root.dataset.density)));
    const motion = pane.querySelector('[data-pref=motion]');
    if (motion) { motion.setAttribute('aria-checked', String(motionAllowed())); motion.disabled = systemMotion.matches; }
    pane.querySelector('[data-pref=transparency]')?.setAttribute('aria-checked', String(root.dataset.effects === 'on'));
  }
  new MutationObserver(syncAppearance).observe(document.documentElement, { attributes: true, attributeFilter: ['data-family','data-theme','data-density','data-motion','data-effects'] });
  systemMotion.addEventListener('change', syncAppearance);
  function commitRoute(next, push = true, index = routeIndex) {
    scrolls.set(route, pane.scrollTop); route = next;
    if (push) {
      routeIndex++;
      const url = new URL(location.href); url.searchParams.set('settings', route); url.hash = 'personal-settings';
      history.pushState({ ...history.state, dlPrefsRoute: route, dlPrefsIndex: routeIndex }, '', url);
    } else routeIndex = index;
    renderPane();
    if (route === 'home' && innerWidth <= 760) nav.querySelector('button')?.focus({ preventScroll: true });
    else byId('prefs-title').focus({ preventScroll: true });
  }
  function askToLeave(continuation) {
    profileLeave = continuation;
    showConfirm({ title: '还有未保存的资料', body: '继续编辑可保留修改；也可以放弃本次修改再离开。保存失败时，输入会留在原处。', label: '放弃修改并离开', trigger: document.activeElement, action: () => {
      draftName = savedName;
      // Invalidate a pending demo save so a late result cannot commit discarded input.
      saves.set('profile', { revision: (saves.get('profile')?.revision ?? 0) + 1, state: 'idle' });
      const next = profileLeave; profileLeave = null; next?.();
    } });
    confirm.querySelector('[data-confirm-cancel]').textContent = '继续编辑';
    confirm.querySelector('[data-confirm-accept]').classList.remove('primary');
    const status = document.createElement('p'); status.dataset.leaveStatus = ''; status.setAttribute('role', 'status');
    confirm.querySelector('.button-row').before(status);
    const save = document.createElement('button'); save.type = 'button'; save.className = 'btn primary'; save.dataset.saveLeave = ''; save.textContent = '保存并离开';
    confirm.querySelector('.button-row').append(save);
    save.onclick = () => {
      if (!draftName.trim()) { status.textContent = '显示名称不能为空，请返回继续编辑。'; return; }
      const continuation = profileLeave;
      savePreference('profile', draftName.trim(), value => {
        savedName = value;
        if (profileLeave === continuation && confirm.open) { profileLeave = null; confirm.close(); continuation?.(); }
      });
    };
  }
  function requestRoute(next) {
    if (!allowedRoutes.includes(next) || next === route) return;
    if (route === 'profile' && profileDirty()) askToLeave(() => commitRoute(next));
    else commitRoute(next);
  }
  window.addEventListener('popstate', event => {
    if (restoringPop) {
      restoringPop = false;
      const prompt = pendingPopPrompt; pendingPopPrompt = null; prompt?.();
      return;
    }
    const next = allowedRoutes.includes(event.state?.dlPrefsRoute) ? event.state.dlPrefsRoute : 'home';
    const index = event.state?.dlPrefsIndex ?? 0;
    if (!allowPop && route === 'profile' && profileDirty() && next !== route) {
      const delta = index - routeIndex;
      const prompt = () => askToLeave(() => {
        allowPop = Boolean(delta);
        if (delta) history.go(delta); else commitRoute(next, false, index);
      });
      // Restore the current history entry before presenting choices. Otherwise a
      // quick confirmation can race the compensating browser history traversal.
      if (delta) { pendingPopPrompt = prompt; restoringPop = true; history.go(-delta); }
      else prompt();
    } else { allowPop = false; commitRoute(next, false, index); }
  });
  shell.addEventListener('click', event => {
    const routeButton = event.target.closest('[data-route]'); if (routeButton) requestRoute(routeButton.dataset.route);
    const family = event.target.closest('[data-pref-family]'); if (family) { setFamily(family.dataset.prefFamily); savePreference('theme', family.dataset.prefFamily); }
    const mode = event.target.closest('[data-pref-mode]'); if (mode) { setTheme(mode.dataset.prefMode); savePreference('mode', mode.dataset.prefMode); }
    const density = event.target.closest('[data-pref-density]'); if (density) { document.documentElement.dataset.density = density.dataset.prefDensity; pressed('#density-controls', 'density', density.dataset.prefDensity); savePreference('density', density.dataset.prefDensity); }
    const toggle = event.target.closest('[data-pref]');
    if (toggle && !toggle.disabled) {
      const key = toggle.dataset.pref, enabled = toggle.getAttribute('aria-checked') !== 'true'; toggle.setAttribute('aria-checked', String(enabled));
      if (key === 'motion') byId('motion-toggle').click();
      if (key === 'transparency') byId('effects-toggle').click();
      savePreference(key, enabled);
    }
    const retry = event.target.closest('[data-retry]'); if (retry) { const pending = saves.get(retry.dataset.retry); savePreference(retry.dataset.retry, pending.value, pending.onSuccess); }
    if (event.target.closest('#prefs-save-profile')) savePreference('profile', draftName.trim(), value => { savedName = value; if (byId('prefs-name')) byId('prefs-name').value = draftName; });
    if (event.target.closest('#prefs-discard')) { draftName = savedName; byId('prefs-name').value = draftName; saves.delete('profile'); refreshStatus('profile'); }
    const command = event.target.closest('[data-demo-command]');
    if (command?.dataset.demoCommand === 'push-help') showConfirm({ title: '配置手机推送', body: '在 ntfy 客户端中添加当前空间地址与专属订阅配置。正式产品会提供经过授权的配置信息；此草稿不会生成订阅或发送通知。', label: '知道了', trigger: command });
    if (command?.dataset.demoCommand === 'rotate') showConfirm({ title: '轮换连接凭据？', body: '真实操作会使旧凭据失效，需要更新外部运行时。本页只演示确认与取消，不生成或撤销任何 Token。', label: '确认演示', danger: true, trigger: command, action: () => { command.textContent = '已演示确认 · 没有修改真实凭据'; } });
  });
  pane.addEventListener('input', event => { if (event.target.id === 'prefs-name') { draftName = event.target.value; updateProfileActions(); } });
  pane.addEventListener('change', event => { if (event.target.id === 'prefs-frequency') savePreference('frequency', event.target.value); });
  byId('prefs-fail-next').onclick = () => { failNext = !failNext; byId('prefs-fail-next').setAttribute('aria-pressed', String(failNext)); byId('prefs-fail-next').textContent = failNext ? '已开启 · 下次保存会失败' : '模拟下一次保存失败'; };
  renderPane();
  const controlRange = byId('controls-range'), controlSize = byId('controls-size');
  const updateSize = source => {
    const valid = source.value !== '' && source.validity.valid;
    controlSize.setAttribute('aria-invalid', String(!valid));
    if (!valid) { byId('controls-size-help').textContent = '请输入 12–20 之间的整数。'; return; }
    const value = Number(source.value);
    controlRange.value = controlSize.value = String(value);
    controlRange.style.setProperty('--range-fill', `${(value - 12) / 8 * 100}%`);
    byId('controls-type-preview').style.fontSize = `${value}px`;
    byId('controls-size-help').textContent = `${value} px · 仅调整这段示例文字`;
  };
  controlRange.addEventListener('input', () => updateSize(controlRange));
  controlSize.addEventListener('input', () => updateSize(controlSize));
  updateSize(controlRange);
  byId('controls-select').addEventListener('change', event => { byId('controls-select-feedback').textContent = `当前预览：${event.target.selectedOptions[0].textContent}`; });
  document.querySelectorAll('[data-selection-example]').forEach(example => {
    example.querySelectorAll('[data-selection-icon]').forEach(node => { node.outerHTML = icon(node.dataset.selectionIcon); });
    const tabs = [...example.querySelectorAll('[role=tab]')];
    const activate = tab => tabs.forEach(item => {
      const selected = item === tab;
      item.setAttribute('aria-selected', String(selected));
      item.tabIndex = selected ? 0 : -1;
      byId(item.getAttribute('aria-controls')).hidden = !selected;
    });
    tabs.forEach((tab, index) => {
      tab.addEventListener('click', () => activate(tab));
      tab.addEventListener('keydown', event => {
        const vertical = tab.parentElement.getAttribute('aria-orientation') === 'vertical';
        const previous = vertical ? 'ArrowUp' : 'ArrowLeft', next = vertical ? 'ArrowDown' : 'ArrowRight';
        if (![previous, next, 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const target = tabs[event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === next ? 1 : -1) + tabs.length) % tabs.length];
        activate(target); target.focus({ preventScroll: true });
      });
    });
  });
})();
