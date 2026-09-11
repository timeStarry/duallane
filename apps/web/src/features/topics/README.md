# 话题交互

`WorkspaceTopics.tsx` 保留列表、成员、消息、投影与通知领域控制；话题通过 `TopicChatRuntime` 使用与群聊完全相同的完整消息视图、正文渲染、表情选择、附件传输和消息命令，不维护独立消息行、内容白名单、编辑器或提及菜单。本目录负责显式创建、话题展示投影和按目标隔离的本次登录会话状态。

- `TopicCreateButton` 在全局话题列表和群详情打开同一表单。向已有 `POST /api/workspace/conversations/:id/topics` 发送独立 JSON 字段，不拼接快捷语法。表单校验与 Go 的标题、字符数和字节限制一致；服务器继续执行权限、幂等、群卡片、配额和审计规则。
- 同一份输入重试复用同一个幂等键，修改输入后生成新键。失败保留表单；成功先结束导航保护，再进入服务器返回的话题。原群聊草稿由 App 保留。
- `registerNavigationGuard` 接受 shell 的 `NavigationGuard`。有改动或请求处理中注册，关闭和卸载清除；处理中 `discard()` 返回 `false`。`completed()` 只在服务器明确创建成功后为真，使已经完成的创建优先于尚未执行的返回意图。
- `createWorkspaceTopicSessionStore()` 由 App 按当前登录用户创建并向话题页传递。草稿、回复、同步选择、待发送原消息和阅读位置按 `topicId` 分开，只留在内存。`hasUnsaved()` 供退出确认和 `beforeunload` 动态检查；普通话题切换保留内容，不询问放弃。
- 发送以 `session.enqueue` 原子捕获目标、内容、附件、回复、同步选择、客户端消息 ID 和草稿修订，再释放当前编辑区。上传图片期间可继续发送下一条；每条消息独立 claim/finish，失败在原消息重试，不能吞掉后来添加的附件。晚响应只结算原提交，不清空新草稿或其他话题。关闭、归档及只读身份禁用公共写操作。
- `chat-adapter.ts` 直接使用共享 `message-projection.ts`；`message-model.ts`、`message-content.ts`、`message-commands.ts` 统一完整 DTO、结构化编码、长消息转 TXT、回复自动提及和对象命令。原始引用 ID 可通过同作用域 around 查询定位历史消息；隐藏或撤回的引用不泄露正文。
- 图片、文件、内置及自定义图片表情、合集、卡片、反应、常驻、撤回、个人隐藏/恢复沿用完整 Workspace 消息链路；话题仅追加同步到群聊动作。关闭/归档后保留内容、预览及反应展示，公共写操作禁用，个人隐藏/恢复仍需有效成员权限。未加入只能查看摘要。
- 顶部仅显示所属群、人数与详情入口；`TopicDetails` 默认关闭，桌面右侧打开、手机独立详情层，集中展示说明、提醒、参与和管理操作。Escape/关闭归还焦点，目标改变关闭旧详情。
- 可见且位于消息底部时确认最新服务端消息已读；回到最新、手动滚底和重新显示页面均可补确认。确认请求按当前话题代次去重并串行合并，失败不更新已确认游标；阅读历史、后台页面及旧作用域不能据此读完新消息。

话题 POST/GET 保持既有路径并添加完整消息字段与 around 查询。Go 通过 topic-scoped transaction adapter 调用普通消息服务，统一校验、附件/表情关联和投影；没有数据库迁移。话题附件使用 `private_staging`，发送后按有效空间、群、话题成员授权；离开或权限撤销清除对应浏览器会话状态并取消上传。草稿不写入浏览器持久存储，也不提供跨端草稿。浏览器刷新/关闭保护遵循浏览器限制，不能保证一定提示或保存。P2P 不消费此状态。

验证：`topics.test.ts` 覆盖输入边界、结构化请求、独立草稿、晚响应和退出检测；`chat-adapter.test.ts` 覆盖作者、支持内容、回复边界和失败身份。`e2e/workspace-topics-ui.spec.ts` 使用真实 Go Workspace harness 验证表单重试、目标与草稿隔离、只读和导航竞争。测试脚本存在不代表本轮已全部通过，完成结果由项目验证记录列明。

在本地 Vite 可用时，从根目录执行 `node apps/web/src/features/topics/verify-shared-chat.cjs`，可用 `DUALLANE_UI_BASE_URL` 指定地址（默认 5186）。脚本以合成 API／WebSocket 响应驱动正式 React 页面，对比群聊和话题的 1440／390／320 布局，并检查回复、提及、原消息重试、新草稿、关闭只读和回到底部已读确认。截图输出到忽略的 `test-results/ui-refinement/topics-shared`；这些检查不代替真实 Go、权限或实际设备验证。
