# Bot 会话上下文授权

`BotContextGrants` 仅用于共享空间，复用真实 Go 接口及 `ui/primitives`。`WorkspaceBotSettings` 注入现有 JSON 请求封装、Bot 所有者投影、设置、Token Scope 摘要和群授权列表；不传递 Token 明文。

- `/conversations` 仅用于筛选当前用户可见的本 Bot 所有者私聊，及既有群授权对应会话。不会手填 ID、枚举不可见对象、创建会话或批准群申请。
- 私聊调用 `PATCH /bots/{botId}/context-grants/{conversationId}`。Go 要求运行中的 Bot、Bot 所有者、`allowDirect=true` 且是该所有者与 Bot 的私聊。没有对应 GET：首屏明确当前授权未知，只有本次成功返回的 grant 可展示为已确认值。
- 群调用 `PATCH /bots/{botId}/group-policies/{conversationId}`，保持已返回的 `active` 状态。群列表投影提供真实授权；会话 `canManageMembers` 与当前可见性共同控制入口。Go 再次校验 Bot 所有者、有效群成员及空间 owner/admin 身份。pending/rejected/removed、不可见或无管理权限的行只读。
- `allowTrigger` 与 `allowContext` 独立；每次显式提交一个 1–200 的 `maxMessages`。关闭两个开关仍需保存，保留群成员关系，不撤销 Token。实际上下文仍取服务端各限制交集。
- 未提交编辑可通过 `registerNavigationGuard` 接入 App；保存失败保留输入，已发送请求未完成时不允许放弃离开。不把前端隐藏当授权，也不新增后端写入者、SQL 或持久化格式。

验证：`context-grants.test.ts` 覆盖候选范围、未知状态、接口分流、只读权限、不自动入群和数量边界；`e2e/workspace-bot-context-grants.spec.ts` 使用 Go Workspace 验证显式提交、失败重试、私聊/群授权与 Token Scope 独立限制。

`WorkspaceBotSettings` 使用正式 `Tabs` 将资料、连接、授权、凭据分章。隐藏章节保持挂载，输入、失败状态、一次性 Token 的本页内存显示和授权离开确认不会随章节切换被重置；退出整个 Bot 设置仍遵循原有清理行为。

`node apps/web/src/features/bots/verify-management-layout.mjs` 验证这些真实组件与 Echo 管理页在 1280/780/390px 的布局、可达操作和跨章节草稿，使用合成传输数据；设置 `DESIGN_SCREENSHOT_DIR` 可保留截图。这不是服务端验收。真实 Go 验证仍使用 `workspace-agent-bot.spec.ts`、`workspace-bot-context-grants.spec.ts` 和 `workspace-management-layout.spec.ts`，后者只创建并撤回测试征集草稿，不发布投票。
