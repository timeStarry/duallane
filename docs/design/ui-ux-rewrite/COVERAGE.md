# UI/UX 全量重构覆盖账本

本账本以 `origin/main` 的 `ef51873`（0.18.0，Go-only 在线架构）为能力基线，记录新界面承接的页面、重要浮层、交互能力及验收责任。核对日期：2026-09-11。实现位于当前分支；首轮样式统一后的结构调整见 [页面精修](PAGE_REFINEMENT.md)，最新话题与群聊共用视图的修正和验证见 [会话一致性](CONVERSATION_PARITY.md)，首轮真实 Go 回归与组件检查见 [正式验证记录](PRODUCTION_VERIFICATION.md)。这些记录不代表生产已启用。

**“已接入／待完整验收”表示正式入口已采用新设计语言，不能解释为该行所有角色、设备、失败分支均通过验收。** 当前已有能力与新增设计要求分别写明。合并前结果见 [PR 验证记录](PR_VERIFICATION.md)；自动化证据按任务分组关联，真机和完整辅助技术检查保持开放。

“当前页面／能力”列主要记录基线入口和领域能力，不应把其中的旧等待页、昵称自动保存或群内话题目标当作新实现。目标列与下方本轮实现记录说明其替换方式。页面采用新变量或存在一张截图不足以核销结构、业务及失败状态。

## 使用与切换规则

- 右键、长按、更多入口，以及个人设置目录、子页和保存／返回按照 [专项规格](CONTEXT_AND_SETTINGS.md) 验收；下列消息、文件、会话、成员和个人设置项均须核对相应适用规则，不能只重绘按钮。
- 全量切换前逐项核销，不得因为某页面没有出现在原型中而删除旧功能、入口、角色状态或深链接。一个样例按钮不等于一条用户流程完成。
- 目标是一套覆盖全产品的新界面，不提供线上切换回旧皮肤的用户开关。开发期间可按模块交付，但最终出口只有新设计语言。
- 保留技术与数据兼容：路由和邀请返回目标、已保存消息及附件引用、P2P 本地存档、个人偏好、消息/请求幂等标识、权限投影及现有 API 契约。技术兼容不等于保留旧界面。
- P2P 与 Workspace 的上下文、存储和授权边界不合并。`#k=` 只留浏览器；P2P 内容不写入服务端；Workspace 的授权、配额、保留、并发和内容无关审计记录继续由 Go 服务保证。
- 以下每行都继承通用验收：加载、空态、有效内容、长内容、失败重试、不可用/撤权；适用时覆盖失效、冲突、重复请求和离开。键盘、焦点、明暗主题、触控、窄屏、安全区域和中文输入法须按实际交互验收，不机械地给静态文字添加无关状态。
- 不把未实现的全文消息搜索、操作记录页面、时间型保留编辑、原生客户端、账号注销等未来能力写成迁移完成项；若另行决定新增，应明确新增范围和协议前提。

## 角色与能力基线

页面入口依据服务端 `permissions` 和对象 `capabilities`，不以角色名称推断对象访问权。下表来自 [Go bootstrap 权限函数][permissions] 与 [权限矩阵测试][permission-tests]；成员和会话对象仍须单独授权。

| 角色 | 当前可用的全局能力 | 空间设置归属与限制 |
| --- | --- | --- |
| `owner` / 空间主人 | 读会话、发起私聊、建群、上传下载、普通及特权邀请、成员可见范围、邮件配置 | 概览、邀请、权限、可见范围、邮件；系统统计、Echo 需求及发布管理按当前 owner 检查开放。不能据此推断可读取任意人的私聊。 |
| `admin` / 管理员 | 读会话、发起私聊、建群、上传下载、普通成员邀请 | 概览与普通邀请；当前没有特权邀请、空间角色分配、可见范围或系统邮件配置能力。群管理取决于会话 capability。 |
| `member` / 成员 | 读已授权会话、发起允许的私聊、上传下载 | 概览及自身额度/可见信息；没有建群或邀请管理能力。个人 Bot 的管理依据 Bot 所有权，不要求成为空间主人。 |
| `auditor` / 预留角色 | 当前 bootstrap 权限全部为 false；普通呈现中角色标签可能显示为“成员” | 保留安全降级和无权限状态，不把它设计成已可工作的审计控制台。 |

所有角色当前 `canViewOperationRecords=false`。操作审计是必须保留的后台能力，**没有需要搬迁的现有操作记录 UI**。保留角色兼容与 owner 的受限管理入口，不给普通成员增加审计功能或展示隐藏资源。

新导航向普通 member/guest 显示聊天、话题、文件、成员、个人五项；owner/admin 增加空间入口。这里的导航呈现不新增服务器角色或授予能力。旧空间深链接保留，仍按服务器权限显示可见摘要或受限状态。

## 1. 全局入口、导航与反馈

| ID | 当前页面/能力与来源 | 目标归属及新设计要求 | 关键角色/状态 | 交付状态 |
| --- | --- | --- | --- | --- |
| G01 | `/` 双通道选择；[App 的 entry 分支][app] | 产品入口：名称、通道图标和内容去向共同识别；进入独立上下文，不自动复制身份、消息或文件。 | 未登录；P2P 无账号；Workspace 需准入。 | 已接入／待完整验收 |
| G02 | `/about`、当前版本、历史折叠与更新分类；[AboutPage][about]、[releases][releases] | 关于与版本：保留产品边界说明、完整历史、发布日期及可访问折叠；保持从入口可达。 | 未登录也可读；长更新说明、键盘展开。 | 已接入／待完整验收 |
| G03 | 版本更新提示、刷新和关闭；[App 的 app-version-update][app] | 全局更新反馈：提示不遮挡会话，刷新前处理未提交内容；关闭行为稳定。 | 新版本；当前草稿/传输进行中。 | 已接入／待完整验收 |
| G04 | 浅色/深色/跟随系统、账号菜单、返回入口、退出；[ThemeSwitch / App][app] | 外观归个人/应用偏好，空间操作归空间上下文；返回入口与退出登录含义明确，统一焦点恢复。 | 三种主题模式；不同设备入口；登录状态变化。 | 已接入／待完整验收 |
| G05 | 语义路由、旧 query 规范化、前进后退、刷新和 OAuth 返回；[app-route.ts][routes] | 全部路由映射继续有效；新增信息架构不能丢失 conversation/topic/file/member/setup/share 目标及层级返回。 | 无效路径、失权资源、旧 P2P 链接、邀请返回；秘密片段不外发。 | 已接入／待完整验收 |
| G06 | InlineNotice、Toast、菜单/Tab 键盘、Skeleton、复制反馈；[App 的共享交互][app] | 共享反馈和浮层组件：操作结果就地呈现；状态布局稳定；关闭、Escape、焦点恢复和读屏公告统一。 | 成功、失败、自动关闭、持久错误、复制失败；仅在适用浮层约束焦点。 | 已接入／待完整验收 |

## 2. P2P 全生命周期与本地存档

| ID | 当前页面/能力与来源 | 目标归属及新设计要求 | 关键角色/状态 | 交付状态 |
| --- | --- | --- | --- | --- |
| P01 | `/direct` 发起表单：名称、可选口令、固定两人；[createP2pRoom / name 分支][app] | 创建入口突出名称；可选安全设置渐进展开，固定人数改为说明；提交期间反馈明确。 | 无账号；空名称、创建失败、重复提交。 | 已接入／待完整验收 |
| P02 | `/direct/:roomId` 受邀加入；密钥准备与验证；[App][app]、[P2P 隐私测试][p2p-privacy] | 加入入口保留必要名称/口令；明确这是受邀会话；失败不要求用户理解原始协议字段。 | 缺失/非法密钥、口令不匹配、房间失效、满员。 | 已接入／待完整验收 |
| P03 | 创建后 waiting 分享页与“进入聊天”；[waiting 分支][app] | 将创建成功、复制邀请和等待组织进连续会话壳层；连接何时建立需随流程修改明确，不能仅隐藏按钮。 | 分享成功/复制失败、尚无对端、准备密钥；完整链接只经用户选择分享。 | 已接入／待完整验收 |
| P04 | 聊天文本、表情、草稿和发送确认/重试；[ChatPanel / sendP2pMessage][app] | 共用消息及编辑器外壳，保留 P2P 能力边界和中文输入法；当前 P2P 调用没有启用通用 ChatPanel 的提及/回复参数，不能将参数存在等同于已开放能力。 | 等待对端、发送中、确认超时、重试、加密信封降级；不得改用 Workspace 传输。 | 已接入／待完整验收 |
| P05 | 文件选择、请求、接收/拒绝、进度、重试与保存；[FileTransferCard][app] | P2P 传输模式：先确认接收，再清楚显示传输和本机保存状态；普通聊天不中断。 | 对端不可用、拒绝、传输中、失败、完成/待保存；大文件限制。 | 已接入／待完整验收 |
| P06 | 状态摘要/诊断浮层：RTC、DataChannel、加密转发、恢复建议；[P2pStatusControl][app] | 常驻短状态，展开才呈现诊断与可行动建议；“连接状态”和“不在服务器保存”分开表达。 | 直连、加密转发、协商、离线、自动重连、无法解密。 | 已接入／待完整验收 |
| P07 | 会话详情：对端、房间信息、校验信息和再次复制邀请；[RoomDetails][app] | 上下文详情保留核对入口；技术字段按需展开，邀请链接不进入通用日志或服务端渲染。 | 展开/收起；长链接；对端加入/离开；键盘复制。 | 已接入／待完整验收 |
| P08 | “结束”进入 ended，再选本地保存；顶部返回直接重置；[ended / resetToEntry][app] | 统一结束与返回的离开决策；有未保存内容/传输时明确后果；保留不保存选择，不默认持久化。 | 主动结束、返回、未完成传输、无内容、已保存；连接关闭与存档决策分开。 | 已接入／待完整验收 |
| P09 | 浏览器存档、历史选择/预览、JSON 导出、全部清除；[SavedSessionsPanel / saveP2pSession][app] | 本地存档工具：区分“保存在此浏览器”和“导出文件”，说明明文与范围；结束页及开始页的既有入口可达。 | 空历史、旧记录读取、已保存、导出、清除；不得迁入 Workspace。 | 已接入／待完整验收 |

## 3. Workspace 准入、会话与话题

| ID | 当前页面/能力与来源 | 目标归属及新设计要求 | 关键角色/状态 | 交付状态 |
| --- | --- | --- | --- | --- |
| W01 | `/workspace` 登录、加载、disabled 和错误页；[Workspace 准入分支][app] | 准入页保留 GitHub 登录唯一公开主入口；停用、加载失败和未登录各有明确下一步。 | `WORKSPACE_ENABLED` 未精确为 true 时不开放；网络失败；重试。 | 已接入／待完整验收 |
| W02 | `?invite=` 准入、OAuth 返回与账号检查；[routes][routes]、[登录文案测试][login-tests] | 邀请接受与原目标衔接；无邀请码、已是成员、未受邀、拒绝/失效反馈不能退化为同一空白页。 | 已登录/未登录；邀请过期/撤销/用尽；账号不匹配；不泄露他人身份。 | 已接入／待完整验收 |
| W03 | WorkspaceShell、移动导航、详情窗格、账号/创建菜单；[WorkspaceShell][app] | chat/topics 中栏可折叠且保留草稿；files/members 单一主列表；桌面 360px 详情正文独立滚动、手机整页，未选对象无旧详情。用户菜单不重复主导航。 | 按能力显示五／六项导航；加载、无权限、宽度变化、旧空间深链。 | 已接入／待完整验收 |
| W04 | 会话列表、搜索筛选、最近消息/时间、未读；[conversation list / helpers][app] | 会话列表模式统一密度、身份、未读与操作入口；保留现有筛选范围，不承诺全文搜索或已存在会话置顶。 | 私聊/群聊/Bot；无会话、长名称、无结果、未读、已静音。 | 已接入／待完整验收 |
| W05 | `/workspace/new/direct`、成员入口发起私聊；[createWorkspaceDirect][app] | 成员选择 → 确认对象 → 私聊；搜索和返回保持上下文；明确仍属于服务器保存的空间通道。 | `canCreateDirect` + 对象 `canStartDirectConversation`；已存在私聊、对方不可发现/已移除。 | 已接入／待完整验收 |
| W06 | `/workspace/new/group` 创建群聊、成员选择；[群创建分支][app] | 专注建群流程，名称与成员就地校验；可取消并返回起点，重复创建不可由双击触发。 | owner/admin 且 `canCreateGroup`；候选成员能力、失败/进行中。 | 已接入／待完整验收 |
| W07 | `/workspace/chat/:id` 私聊、群聊、系统/自定义 Bot 会话；[WorkspaceChatPanel][app] | 统一 ConversationShell 与消息基础呈现；Bot 标签和来源持续可见，按目标显示允许能力。 | 会话成员资格、被移除、Bot 暂停/停用、系统消息；撤权后清除不可读内容。 | 已接入／待完整验收 |
| W08 | Lexical 草稿、换行/IME、提及、格式工具、表情及展开编辑；[WorkspaceComposerEditor][composer]、[主聊天集成][app] | Composer 明确发送目标、输入模式、附件与发送状态；会话切换不串草稿，焦点和选区稳定。 | 文本/仅提及/多行/表情；空内容、输入法确认、发送中、失败保留。 | 已接入／待完整验收 |
| W09 | 消息附件队列、上传进度、超长文本转附件、取消/重试；[WorkspacePendingAttachmentList / 上传流程][app] | 发送前可检查附件；上传、发送、取消状态各自准确；重试沿用身份避免重复消息/文件。 | 图片/文件/长文本；额度不足、上传中、失败、撤权、取消后迟到响应。 | 已接入／待完整验收 |
| W10 | 消息菜单、回复/定位、复制、表情回应/收藏、隐藏、撤回、群常驻；[消息操作与 WorkspaceReactionBar][app] | 收敛桌面和触控操作；区分个人隐藏、偏好折叠、撤回与常驻，不把它们统称删除。 | 作者/其他成员/群管理 capability；可撤回范围、已撤回、常驻已存在、重复事件。 | 已接入／待完整验收 |
| W11 | 历史分页、未读定位、around 上下文、返回最新、自动隐藏/展开；[历史与未读状态][app]、[auto-hide][auto-hide] | 阅读状态模式：加载旧消息不跳页；定位/返回最新可预测；个人折叠不影响他人和服务端消息。 | 长历史、被保留策略清除、并发 mark-read、隐藏段、自动隐藏开关。 | 已接入／待完整验收 |
| W12 | 重连、实时对账、未读 favicon、在线状态；[App][app]、[未读 favicon][favicon] | 当前数据、恢复进度和不可发送状态分开表达；保持已读/未读一致，降低重复通知。 | 多设备、断线恢复、乱序/重复事件、切换账号、延迟列表返回。 | 已接入／待完整验收 |
| W13 | 会话详情：概览、文件、成员、群话题、常驻、提醒、群资料和离群；[context 分支][app] | ContextPanel/手机详情页；成员一行一个更多；真实候选搜索和多选邀请串行复用单成员 API，部分成功只重试未成功项；个人提醒与群设置分组。 | `canManageMembers` 才管理群头像/名称/成员；范围失效中止后续邀请，已成功项不回滚；自身离群、失败。 | 已接入／待完整验收 |
| T01 | `/workspace/topics`，全部/参与/创建/未读/关闭筛选及群内入口；[WorkspaceTopicRail / ConversationTopicsSection][topics] | 独立话题列表保留父群归属；统一筛选、空态和返回路径。 | 授权父群成员；无话题、过滤无结果、父群失权。 | 已接入／待完整验收 |
| T02 | `#[标题](正文)` 创建、基线主聊天发送目标选择；[App 的话题入口][app]、[topic tests][topic-e2e] | 独立 JSON 表单创建且保留旧语法；选择已有话题进入目标页，群草稿不迁移，发送目标和同步范围明确。 | 幂等重试、创建中返回、群与话题切换、无效语法、普通消息不被误当指令。 | 已接入／待完整验收 |
| T03 | `/workspace/topics/:id` 群聊子会话；[WorkspaceTopicPage][topics] | 与群聊共用完整消息内容、附件、表情、输入器和对象动作；独立草稿、回复、同步及阅读位置。紧凑横幅与默认关闭的详情按体验规范组织。 | 参与者/非参与者；all/mentions/muted；长标题、窄屏、失败重试、后台上传、批次取消、重复同步、关闭只读、父群撤权。 | 已接入／待完整验收 |
| T04 | 话题关闭/归档与只读终态；[transitionTopic][topics] | 管理操作在详情中解释后果，保留历史与返回入口；不把“归档”误写为物理删除。 | 当前创建者/owner/admin 的管理校验；open/closed/archived，权限拒绝。 | 已接入／待完整验收 |

## 4. 文件、成员与个人偏好

| ID | 当前页面/能力与来源 | 目标归属及新设计要求 | 关键角色/状态 | 交付状态 |
| --- | --- | --- | --- | --- |
| F01 | `/workspace/files` 与会话文件列表，搜索、类别、网格/列表、缩略图；[文件浏览器][app] | 单一主内容；范围、分类和列表／卡片切换采用设计系统的分段选择规则，卡片尺寸也按同一规范；长文件名、来源与上传者稳定可读。 | `canDownload`/可访问附件；空、过滤、长名称、320px；不得展示未授权文件。 | 已接入／待完整验收 |
| F02 | 独立文件上传、分块进度、失败记录/重试、下载额度预检；[上传及 reserveWorkspaceDownload][app] | Transfer 模式复用于聊天和文件库；先检查额度，上传下载计入同一用户日额度；重试不重复扣费/创建记录。 | 上传/下载权限、已用/剩余额度、部分失败、取消、并发请求。 | 已接入／待完整验收 |
| F03 | `/workspace/files/:id` 详情、来源会话定位、下载与移除；[文件详情 context][app] | 文件详情讲清可见范围、保存状态、操作后果；移除与仅清理本地失败项区别明确。 | 上传者/owner/admin 或文件 `canRemove`；失效、无权、被移除、确认取消。 | 已接入／待完整验收 |
| F04 | 图片全屏预览、缩放/复位、下载与文件详情；[workspace-image-viewer][app] | ImageViewer 统一键盘、焦点恢复、触控缩放和边界；图片加载失败仍可返回原消息。 | 长宽图、加载/失败、额度不足、下载不可用；关闭不丢阅读位置。 | 已接入／待完整验收 |
| M01 | `/workspace/members` 搜索、联系人/owner 全成员、角色/身份筛选；[成员列表][app] | PeopleDirectory 先说明“可联系成员”范围；保留头像、Bot 身份及可发现性，不把列表美化变成公开全员目录。 | owner 全量与其他角色授权范围；预留 auditor 筛选受限、无结果。 | 已接入／待完整验收 |
| M02 | `/workspace/members/:id` 资料、发起私聊、群内加人/移除；[WorkspaceMemberDetail / 群成员 context][app] | MemberDetail 与可操作成员选择器；头像、资料和权限反馈一致；对象已移除时安全返回。 | 对象 `canStartDirectConversation`、`canJoinGroups`、`canManage`，群管理 capability。 | 已接入／待完整验收 |
| A01 | `/workspace/account` 分类总览、逐级返回、退出登录；[WorkspaceAccountSettings][app] | 桌面分类／内容独立滚动，手机目录到子页；资料、外观、隐私、聊天、通知、表情、Bot 清楚归属；手机首页可退出。 | 当前登录账号；退出/换号时清除敏感本地状态，迟到保存不能归到新账号。 | 已接入／待完整验收 |
| A02 | `account/profile` 基线昵称自动保存、GitHub 只读信息、头像裁切/删除；[资料设置][app]、[WorkspaceAvatarEditor][avatar-editor] | 昵称改为显式保存，保存区独立于字段；头像、编辑内容与只读身份分开，失败保留输入；头像可预览、取消、缩放。 | 保存中/失败/冲突、无头像、图片校验、长登录身份；当前账号。 | 已接入／待完整验收 |
| A03 | `account/privacy` 搜索可发现性；[隐私设置][app] | PrivacySetting 明确只改变其他成员能否发现自己，已有会话/联系人关系不被误描述为删除。 | 开/关、保存失败、已存在关系；不可扩大全局成员可见范围。 | 已接入／待完整验收 |
| A04 | `account/chat` 自动隐藏分类、撤回原因、内置包、直接发送/回复提及等偏好；[聊天设置][app]、[聊天偏好契约][chat-prefs] | ChatPreferences 收敛同类开关与帮助；区分个人显示、发送方式和消息语义；保留至少一个内置包的限制。 | 加载/重试、开/关/保存失败；消息/话题一致，自定义撤回文案长度。 | 已接入／待完整验收 |
| A05 | `account/notifications` 渠道总览；会话/话题级提醒；[通知设置][app] | NotificationSettings 将渠道与提醒范围关联，相关状态可直达具体渠道；不把全局渠道开关当成覆盖免打扰。 | all/mentions/muted、渠道关闭、服务不可用，已有偏好保留。 | 已接入／待完整验收 |
| A06 | `account/notifications/email` 启停、即时/汇总、GitHub 邮箱/自定义邮箱、验证码；[邮件通知设置][app] | EmailPreference 分清验证与偏好保存；显示脱敏地址、明确无正文通知；失败保留输入。 | 邮件服务未启用、发送/校验中、错误/过期验证码、重试。 | 已接入／待完整验收 |
| A07 | `account/notifications/push` ntfy 启停、配置说明弹窗、服务器/topic 复制与凭据轮换；[ntfy 设置与 dialog][app] | PushSetup 保留配置、下载指引和轮换确认；敏感 topic 只在必要界面展示，不进入通用消息或遥测。 | 开/关、尚未配置、复制失败、轮换中/失败/完成；旧凭据失效。 | 已接入／待完整验收 |
| A08 | `account/appearance`；[正式外观页](../../../apps/web/src/features/settings/AppearanceSettings.tsx) | 五套主题使用实际明暗 Token 的产品缩略窗，只保留标题并横向浏览；显示模式、密度、动态和透明独立，按设计系统的分段选择规则呈现；不重建会话。 | 选中与键盘、浅深/随系统、拖动不误选、存储失败、长文案、桌面/390/320；外观仅存本机。 | 已接入／待完整验收 |

## 5. 表情、自定义 Bot 与授权

| ID | 当前页面/能力与来源 | 目标归属及新设计要求 | 关键角色/状态 | 交付状态 |
| --- | --- | --- | --- | --- |
| E01 | 聊天表情选择器：最近、内置/自定义、面板偏好及直接发送；[EmotePicker][app]、[emotes][emotes] | EmotePicker 统一选择/发送含义，保留键盘、焦点、滚动和聊天草稿；导入资源不重绘。 | 加载、缓存失败、空收藏、包切换；订阅内容只读。 | 已接入／待完整验收 |
| E02 | `account/emotes` 管理器，上传队列、收藏、合集创建/重命名、排序/移动/删除；[WorkspaceEmoteManagerDialog][app] | EmoteLibrary 保留鼠标、键盘及触控组织方式；失败上传可逐项恢复，容量/数量上限就地解释。 | 空库、上传中/失败、达到上限、批量选择、只读订阅合集。 | 已接入／待完整验收 |
| E03 | 表情详情、合集预览、分享创建/复制/撤销、发送至会话；[EmoteManager / SharedEmoteCollectionDialog][app] | EmoteDetail / ShareSheet 区分对外分享与发入指定会话；关浮层回到原位置，禁止串会话。 | 只读/自有、无权、撤销、复制失败、发送目标不可用。 | 已接入／待完整验收 |
| E04 | `/workspace/emotes/shared/:id` 预览、导入、跟随作者、取消订阅/保留快照；[WorkspaceSharedEmoteCollectionPage][app] | SharedCollection 页面完整承接分享深链接；“持续订阅”和“独立副本”意义清楚。 | 未登录、失效/撤销、已导入、同步/脱离、作者变更、容量不足。 | 已接入／待完整验收 |
| B01 | `account/bot` 创建、身份/头像/简介/欢迎语、发现范围、显示创建者；[WorkspaceBotSettings][bot] | BotProfile 在个人范围管理；避免暴露原始成员 ID 作为常用选择方式，但保留当前可配置发现范围语义。 | Bot 所有者；未创建、active/paused/deleting/disabled；保存失败。 | 已接入／待完整验收 |
| B02 | Bot 群策略、邀请策略摘要、授权群数量与限额只读；[Bot 群策略][bot] | BotPermissions 区分“允许触发”“群准入”“读上下文”；按现有三种群策略和服务端限额呈现。 | 仅私聊/群须批准/群可使用；保存中/失败；不把只读策略值做成可任意修改。 | 已接入／待完整验收 |
| B03 | 复制 Agent 配置指令、一次性配置码、`account/bot?setup=` 授权页；[Bot setup 流程][bot] | AgentConnection 分步展示目标 Bot、有效期、scopes 与请求会话；用户明确批准/拒绝，静态 Skill 不代表授权。 | created/awaiting_user/approved/exchanged/denied/expired/revoked；所有者/非所有者。 | 已接入／待完整验收 |
| B04 | Token 生成/轮换/撤销、一次展示/复制；连接状态、心跳/最近错误、连接测试；[Token 与连接区][bot] | CredentialPanel 与 ConnectionStatus 独立；凭据只能在授权位置出现，测试为明确命令；状态不能靠颜色猜测。 | 无 Token/新建/已撤销；离页即不再显示完整值；未连接/异常/恢复、忙碌/失败。 | 已接入／待完整验收 |
| B05 | 暂停/恢复、输入名称确认永久停用；[Bot 生命周期][bot] | BotLifecycle 说明暂停可恢复、停用撤销所有 Token 并移除 Bot 成员身份；危险命令独立。 | active/paused/deleting/disabled；取消/确认、失败和迟到结果。 | 已接入／待完整验收 |
| B06 | **API 已有、未找到独立前端管理入口**：每会话 context grant；[Go Bot 路由][bot-routes]、[README 的授权说明][readme] | 在 Bot/会话权限中设计明确的上下文授权归属；不得将 setup scope 或创建私聊等同于完整历史读取授权。此行是新增可视入口要求。 | Bot 所有者、目标会话授权、grant 撤销/范围变更；API 与令牌 scope 双重约束。 | 已接入／待完整验收 |

## 6. 空间管理、Echo 与可交互卡片

| ID | 当前页面/能力与来源 | 目标归属及新设计要求 | 关键角色/状态 | 交付状态 |
| --- | --- | --- | --- | --- |
| S01 | `/workspace/space` 概览、可见成员、日传输/保留说明；owner 系统统计；[空间 overview][app] | SpaceOverview：普通成员只看有用状态；owner 统计独立区域，保留刷新及加载/失败。现有保留显示不能擅自变成可编辑策略。 | 全角色按可见能力降级；owner 专有统计；零值/未知/不可用。 | 已接入／待完整验收 |
| S02 | `space/invites` 创建、链接复制、有效/历史、使用和受邀成员、撤销；[邀请列表][app] | InviteManager 保留邀请生命周期与接受记录；普通邀请和特权授权不混用；复制后明确后续分享动作。 | owner/admin 的普通邀请；过期/用尽/撤销；没有能力时隐藏且后端拒绝。 | 已接入／待完整验收 |
| S03 | `space/permissions` 角色调整/移除、系统身份限制；[roles 分支][app] | MemberPermissions 解释具体影响；保护不能管理的系统身份，移除/角色变更需明确目标与后果。 | 当前仅 owner 的特权能力；自身份及对象 `canManage`；预留 auditor 兼容。 | 已接入／待完整验收 |
| S04 | `space/visibility` 按查看者管理成员可见范围；[visibility 分支][app] | VisibilityEditor 区分自动可见关系与手动授权；按查看者展示范围，保存后不过度扩大联系人。 | 当前 owner；自动关系只读、授权/撤销、失败、切换查看者的迟到响应。 | 已接入／待完整验收 |
| S05 | `space/email` SMTP/通知系统配置、显式测试；[WorkspaceEmailSettingsPanel][app] | SystemEmailSettings 与个人提醒分开；脱敏凭据、变更结果及测试失败就地呈现。 | 当前 owner 的 `canManageEmailSettings`；未配置/有效/失败；秘密不能在普通资料中回显。 | 已接入／待完整验收 |
| S06 | `space/requirements` Echo 需求筛选/分页/统计、详情、处理历史与状态流转；[WorkspaceEchoRequirements][requirements] | RequirementWorkspace 保留列表—详情—处理闭环；处理结果和历史可追溯，手机返回不清除筛选。 | 当前 owner；提案/正式需求/归档、待审核/推进/交付、冲突/过期操作。 | 已接入／待完整验收 |
| S07 | 公开征集：草稿、发布/关闭/撤回、投票及投递明细/重试；[WorkspaceEchoSolicitations][requirements] | Solicitation 管理与普通成员的投票卡片分开；提交、发布和重试分别显示真实状态。 | owner 管理；成员仅授权投票；重复投票、结束、撤回、部分投递失败。 | 已接入／待完整验收 |
| S08 | owner 版本发布引导广播；成员收到详细版本卡片；[发布流程][app]、[发布 E2E][release-e2e] | ReleaseGuide 保留发布对象、内容与重复发送结果；版本卡片在移动端完整可读，与公开版本历史一致。 | owner 发起；重复广播/部分失败；普通成员只接收可见投递。 | 已接入／待完整验收 |
| C01 | Echo 命令识别、帮助与结果面板，普通聊天不误触命令；[WorkspaceEchoInteraction][echo] | CommandResult 说明执行对象、当前结果和下一步；关闭面板不改变普通消息；按上下文允许命令。 | 普通成员/owner 的命令差异；无匹配、进行中、失败/已完成。 | 已接入／待完整验收 |
| C02 | Echo 分步工作流、草稿恢复、继续/确认/取消、重新加载；[EchoWorkflowPanel][echo] | WorkflowPanel 表达进度、输入与确认，收敛焦点/关闭习惯；若新增回退步骤，须明确服务端状态语义；Strict Mode 不重复执行。 | 活跃/过期/已完成/取消；草稿、并发冲突、网络恢复、终态只读。 | 已接入／待完整验收 |
| C03 | 通用/外部 Bot 卡片、Echo 需求/征集/版本卡、话题与同步投影；[WorkspaceInteractiveCard][cards]、[WorkspaceStructuredMessage][app] | CardRenderer 统一标题、来源、动作、加载和 fallback；不同领域保留独立允许动作，不让卡片绕过消息权限。 | active/失效/已撤销/未知类型、重复点击、版本变化、权限拒绝与可读 fallback。 | 已接入／待完整验收 |

## 7. 覆盖验证与退出条件

正式实现与针对性证据如下；最终规则从 [规范入口](README.md) 查找，提交前执行结果和平台边界以 [PR 验证记录](PR_VERIFICATION.md) 为准。阶段记录保留当时的修正依据。

| 账本范围 | 新实现与针对性回归 |
| --- | --- |
| 主题、通用控件与对象动作 | `ui/theme`、`ui/primitives`、`ui/patterns`；组件工作台及对象作用域、Workspace 对象、P2P 对象浏览器脚本 |
| A01–A08、E01–E04 | `features/settings`、`shell/useNavigationGuard`、`ui/patterns/ConfirmationProvider`；[设置与删除流程](../../../e2e/workspace-ui-rewrite.spec.ts)，导航与确认浏览器脚本；设置布局脚本覆盖实际 React 页面的桌面/390/320 合成数据，不能代替 Go 集成 |
| W03、W13、M02 | 导航／详情重排、`features/members/MemberPickerDialog`；[真实群邀请](../../../e2e/workspace-group-invite-ui.spec.ts)，独立候选选择器脚本；部分成功与作用域失效单独验证 |
| T01–T04 | `features/topics`、`WorkspaceTopics`；[结构化创建、幂等恢复、独立草稿和移动操作](../../../e2e/workspace-topics-ui.spec.ts) |
| T03、W08–W12 | [话题完整消息回归](../../../e2e/workspace-topic-message-parity.spec.ts)：群聊／话题共用内容、图片／文件／表情、对象操作、权限、失败重试、后台上传与取消 |
| B06 | `features/bots/BotContextGrants`；[真实 Go 的私聊/群聊授权及撤销](../../../e2e/workspace-bot-context-grants.spec.ts) |
| S04 | 查看者、账号会话及请求代次守卫；[迟到请求、重复选择和保存期间切换](../../../e2e/workspace-visibility-races.spec.ts) |
| B01–B06、S03–S07 | Bot 四章节、Echo 两个同级入口、角色／可见范围搜索与扁平行；[管理布局场景](../../../e2e/workspace-management-layout.spec.ts)；实际结果及开放项由本轮记录列明 |

### 后续评审要求归档

本表确保后续补充已进入正式规范；只索引规则归属，不建立第二套尺寸或交互定义。

| 反馈范围 | 权威归属 | 覆盖与验证入口 |
| --- | --- | --- |
| 一次性统一、持续按真实页面优化、主题扩展架构 | [规范入口](README.md)、[交付契约](DELIVERY.md) | 全账本、ARCHITECTURE.md、正式组件工作台 |
| 开关圆点、侧栏开关／关闭按钮、成员文字头像居中 | [设计系统](DESIGN_SYSTEM.md) | `ui/workbench/verify.mjs`、`features/members/verify-directory-avatars.mjs`、`shell/verify-navigation-composer.mjs` |
| 侧边／底部导航细条；图文分段单选；长选项下拉；定制滑块／Select | [设计系统](DESIGN_SYSTEM.md) | `ui/primitives/verify-segmented-control.mjs`、`verify-view-mode.mjs`、工作台跨浏览器检查 |
| 群侧栏结构与搜索多选邀请 | [体验与流程](EXPERIENCE.md) | W13、M02、[真实邀请流程](../../../e2e/workspace-group-invite-ui.spec.ts) |
| 普通成员隐藏空间入口、账号菜单去重、中栏折叠及禁用槽位 | [体验与流程](EXPERIENCE.md) | W03、G04、导航与页面精修脚本 |
| 主动发送回到最新、阅读历史时被动追加保位、迟到响应尊重新阅读意图 | [体验与流程](EXPERIENCE.md) | [Workspace 发送与阅读](../../../e2e/workspace-send-scroll.spec.ts)、[P2P 双用户回归](../../../e2e/p2p.spec.ts) |
| 中栏右边界调宽、本机记忆、选中背景与悬停分离 | [设计系统](DESIGN_SYSTEM.md)、[体验与流程](EXPERIENCE.md) | [中栏布局、存储失败、主题与断点回归](../../../e2e/workspace-middle-pane.spec.ts) |
| 中栏移除三点入口，右键／长按／键盘操作不误导航 | [对象操作](CONTEXT_AND_SETTINGS.md) | [中栏桌面及触控菜单回归](../../../e2e/workspace-middle-pane.spec.ts) |
| 话题完整消息、内容宽度状态、按需详情、发送目标隔离 | [体验与流程](EXPERIENCE.md) | T01–T04、完整消息／详情／IME／路由回归 |
| 本人／他人背景、短消息连续表面、行内透明动作、悬浮输入器 | [设计系统](DESIGN_SYSTEM.md) | W07–W12、T03、`verify-message-surfaces.mjs`、`verify-workspace-history.mjs` |
| 五主题产品缩略窗、标题无描述、横向浏览、系统／浅色／深色图文选择 | [设计系统](DESIGN_SYSTEM.md) | A08、`features/settings/verify-appearance.mjs`、主题偏好测试 |
| 个人设置目录／子页、退出登录、表情分类与显式管理工具层 | [对象操作与个人设置](CONTEXT_AND_SETTINGS.md) | A01–A08、E01–E04、[设置真实流程](../../../e2e/workspace-ui-rewrite.spec.ts) |
| PC 右键／手机长按／更多／键盘同源动作 | [对象操作与个人设置](CONTEXT_AND_SETTINGS.md) | 各对象账本项、`ui/patterns` 专项脚本、正式工作台 |
| 文件／相册视图切换、Bot／Echo／空间设置内页结构 | [体验与流程](EXPERIENCE.md)、[设置规范](CONTEXT_AND_SETTINGS.md) | F01–F04、B01–B06、S01–S08、管理布局四宽及真实表单回归 |

以下是现有回归依据，**不是本次已运行通过的结果**。实施时将每行 ID 与实际测试、桌面/移动证据关联；没有自动化覆盖的授权对象或浮层，需要明确补充场景。

| 覆盖范围 | 现有规格依据 | 新界面交付门槛 |
| --- | --- | --- |
| G01–G06、W01–W13、F01–F04、M01–M02、A01–A08 | [workspace.spec.ts][workspace-e2e]、[app-route.test.ts][route-tests]、[权限 UI 测试][ui-permission-tests] | 路由、OAuth、前进后退、加载、焦点、双用户消息/文件/重连，以及全部角色入口逐项验收。 |
| P01–P09 | [p2p.spec.ts][p2p-e2e]、[p2p-ime.spec.ts][p2p-ime]、[p2p-go-privacy.spec.ts][p2p-privacy] | 两浏览器直连/加密转发/恢复/文件；邀请密钥不出浏览器；结束、返回、本机保存和旧存档兼容。 |
| W08–W12、T01–T04 | [workspace-ime.spec.ts][workspace-ime]、[话题与 Echo 流程][topic-e2e]、[未读竞争][state-races]、[撤权竞争][access-races]、[常驻同步][pin-e2e] | 输入法不误发送、目标不串、同步幂等；撤权后的迟到响应不能恢复已移除会话。 |
| A04、E01–E04 | [自动隐藏][auto-hide-e2e]、[表情订阅][emote-sub-e2e]、[表情上传响应][emote-response-e2e]、[表情布局流程][workspace-e2e] | 个人偏好隔离、订阅/独立快照、合集只读、排序和多层浮层关闭后上下文不丢失。 |
| B01–B06 | [Agent Bot E2E][bot-e2e]、[Bot 设置测试][bot-tests]、[Go Bot 路由][bot-routes] | 真实授权范围/一次性交换/Token 生命周期与 UI 一致；新增 context grant 入口需补充专门的批准、撤销和越权验证。 |
| S06–S08、C01–C03 | [Echo/话题 E2E][topic-e2e]、[Strict Mode][echo-strict-e2e]、[发布引导][release-e2e]、[卡片测试][card-tests]、[工作流多视口][visual-e2e] | 需求/投票/发布/工作流不重复执行；所有终态和失败可读可恢复，手机完整操作。 |

最终切换还须满足：

1. 对照 [完整路由枚举][routes]，每个现有 route、accountSection、spaceTab、查询参数及其失效状态均有新归属；没有仅靠手工隐藏入口的“已完成”。
2. 对照本账本，重要浮层与消息内能力全部完成；新旧截图只用于评审对照，不成为线上两套皮肤。
3. 390 × 844、320px 窄屏及相关宽屏、平板/分屏、200% 缩放、键盘/触控、减弱动态验证；五套主题明暗模式与密度／透明选项按验收矩阵覆盖。软键盘与安全区域另做真机验收，已有截图不能核销整张矩阵。
4. 按 [Testing and release][testing] 完成所需门槛。0.18.0 的默认 `pnpm test:e2e` 只覆盖 P2P；Workspace 须运行独立的 `pnpm test:e2e:workspace-go` 和所需 PostgreSQL 验证，不能把默认命令通过当成全产品验收。
5. 所有新增行为和旧能力差异有明确设计决定；未完成项不得被原型交互、静态样例数据或“已支持未来扩展”的措辞代替。

[readme]: ../../../README.md
[app]: ../../../apps/web/src/App.tsx
[routes]: ../../../apps/web/src/app-route.ts
[route-tests]: ../../../apps/web/src/app-route.test.ts
[about]: ../../../apps/web/src/AboutPage.tsx
[releases]: ../../../apps/web/src/releases.ts
[permissions]: ../../../apps/backend/internal/workspace/bootstrap/service.go
[permission-tests]: ../../../apps/backend/internal/workspace/bootstrap/service_test.go
[ui-permission-tests]: ../../../apps/web/src/workspace-ui-permissions.test.ts
[login-tests]: ../../../apps/web/src/workspace-login-copy.test.ts
[composer]: ../../../apps/web/src/WorkspaceComposerEditor.tsx
[auto-hide]: ../../../apps/web/src/workspace-auto-hide.tsx
[favicon]: ../../../apps/web/src/workspace-unread-favicon.ts
[topics]: ../../../apps/web/src/WorkspaceTopics.tsx
[avatar-editor]: ../../../apps/web/src/WorkspaceAvatarEditor.tsx
[chat-prefs]: ../../WORKSPACE_CHAT_PREFERENCES.md
[emotes]: ../../../apps/web/src/emotes.tsx
[bot]: ../../../apps/web/src/WorkspaceBotSettings.tsx
[bot-routes]: ../../../apps/backend/internal/workspace/httpapi/bot_routes.go
[bot-tests]: ../../../apps/web/src/WorkspaceBotSettings.test.tsx
[requirements]: ../../../apps/web/src/WorkspaceEchoRequirements.tsx
[echo]: ../../../apps/web/src/WorkspaceEchoInteraction.tsx
[cards]: ../../../apps/web/src/WorkspaceInteractiveCard.tsx
[card-tests]: ../../../apps/web/src/WorkspaceInteractiveCard.test.tsx
[p2p-e2e]: ../../../e2e/p2p.spec.ts
[p2p-ime]: ../../../e2e/p2p-ime.spec.ts
[p2p-privacy]: ../../../e2e/p2p-go-privacy.spec.ts
[workspace-e2e]: ../../../e2e/workspace.spec.ts
[workspace-ime]: ../../../e2e/workspace-ime.spec.ts
[topic-e2e]: ../../../e2e/workspace-v015.spec.ts
[state-races]: ../../../e2e/workspace-state-races.spec.ts
[access-races]: ../../../e2e/workspace-access-races.spec.ts
[pin-e2e]: ../../../e2e/workspace-pin-sync.spec.ts
[auto-hide-e2e]: ../../../e2e/workspace-auto-hide.spec.ts
[emote-sub-e2e]: ../../../e2e/workspace-emote-subscription.spec.ts
[emote-response-e2e]: ../../../e2e/workspace-emote-response.spec.ts
[bot-e2e]: ../../../e2e/workspace-agent-bot.spec.ts
[echo-strict-e2e]: ../../../e2e/workspace-echo-strict-mode.spec.ts
[release-e2e]: ../../../e2e/workspace-echo-release.spec.ts
[visual-e2e]: ../../../e2e/workspace-v015-visual.spec.ts
[testing]: ../../development/TESTING_AND_RELEASE.md
