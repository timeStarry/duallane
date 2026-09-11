# 正式设置模块

`WorkspaceAccountSettings` 是共享空间个人设置的实际页面，使用现有接口；由 App 提供身份、路由和服务适配。
`AppearanceSettings` 使用 `AppearanceProvider`，外观只存这台设备，不请求账号同步。

- `services` 注入现有 `workspaceJson`、`workspaceFetch`、`loadWorkspaceEmoteLibrary` 和 `copyText`。
- 原有 `currentUser`、`section`、`onNavigate`、`onBack`、`onUserUpdated`、`onChatSettingsUpdated`、`onManageEmotes`、`onNotice`、`onLogout` 接口保留。
- `registerNavigationGuard` 在资料有改动时接收 `{ message, save, discard }`，无改动和卸载时接收 `null`。App 在执行路由、返回或退出的副作用前显示确认；仅 `save()` 返回 `true` 才执行导航。`discard()` 在已提交的保存仍等待响应时返回 `false`，不能在此时卸载资料页或声称撤销请求。
- `onDirtyChange` 可选，用于外层显示状态。资料草稿属于当前账号挂载周期；应继续使用 `key={currentUser.id}`。
- 昵称允许为空，沿用后端 `nickname: null` 恢复 GitHub 身份名称的语义。头像独立上传，不与昵称伪装成原子事务。
- `SettingsLayout` 可包裹独立的 Bot、表情管理或分享页面，保留固定分类导航。手机 `home → 分类 → 通知子页`，桌面双栏。
- `/workspace/account/emotes` 仅表示表情设置分类，进入或刷新不会自动弹窗。
  “管理我的表情”显式打开应用层管理弹窗，关闭不写路由、不增加历史记录；
  聊天入口在原会话上打开，保留草稿。关闭回到原触发项，选择器已卸载时回到原编辑器；
  路由改变或会话退出会清理弹窗状态，不向其他页面恢复旧焦点。
- `WorkspaceEmailSettingsPanel` 属于**空间管理**，父组件继续校验 `canManageEmailSettings`；不能放进个人邮件通知分类。

目录只依赖正式 `ui/theme`、`ui/primitives`、已有头像与消息显示模块。没有反向引用 App 或 HTML 原型。
组件回归使用 `profile-draft.test.ts` 检查显式提交、重试、并发、账号退出及取消语义；真实权限和持久化仍由 Go Workspace 浏览器门禁验证。

设置正文由 `dl-settings-page-body` 限定阅读宽度，分组、字段说明与保存状态共享间距。资料保存区是独立页脚；邮件提醒分为开关、接收频率与通知邮箱。外观用实际生产色值绘制缩略产品窗，键盘和指针选择同一主题，明暗、密度、动态与透明度分别保存。

`ThemePicker` 管理主题预览条：只显示预览、标题和选中标记，五套主题沿单行横向排列。
触摸和触控板使用浏览器滚动；鼠标超过移动阈值才进入拖动，拖动结束不会触发主题切换。
左右按钮浏览，方向键／Home／End 移动焦点，Enter／Space 确认；浏览本身不保存偏好。
选中主题重新进入时恢复可见，横向定位不主动改变设置正文的纵向阅读位置。
退出登录复用共享危险按钮，继续调用原 `onLogout` 与未保存资料保护。

`node apps/web/src/features/settings/verify-appearance.mjs` 自行启动独立 Vite，使用合成身份
验证正式 App 的横向主题选择、持久化、移动手势、退出按钮形状及键盘状态。
截图输出 `.private-test-results/appearance-refinement`，不代替真实退出接口验证。

`node apps/web/src/features/settings/verify-layout.cjs` 对实际 React 页面注入合成数据，检查桌面 1440、手机 390 / 320 的设置与话题布局、主题键盘选择、明暗预览与本机保存，以及状态标签和发送键。运行前启动 Vite；可用 `DUALLANE_UI_BASE_URL` 指定地址（默认 `http://127.0.0.1:5186`），截图输出 `test-results/ui-refinement/settings`。这是布局与前端交互检查，不能作为真实 Go 服务集成证据。

`node apps/web/src/features/settings/verify-navigation.mjs` 在独立随机端口挂载真实 React hooks，检查保存失败重试、已提交请求期间拒绝放弃、草稿保存后保留确认意图、已确认导航的嵌套与异常恢复，以及消息对象失效／原生文本／切换会话的焦点边界。这是前端交互回归，不替代真实 Go 接口和浏览器历史端到端验证。
