# 生产界面样式的职责

本目录记录当前实现的样式边界。设计目标见
[设计系统](../../../../../docs/design/ui-ux-rewrite/DESIGN_SYSTEM.md)；
这里描述实际代码，不代替产品验收。

## 语义来源

- [theme/tokens.ts](../theme/tokens.ts) 是原色、苔原、暮色、米色、极简五组浅深配色的生产来源。
- [theme/appearance.ts](../theme/appearance.ts) 把主题解析结果写入根元素的语义变量。
  `--ink`、`--panel`、`--relay` 等既有名称只映射到新语义值，没有旧配色回退。
- 主题、明暗、密度、动态效果和透明材质分别解析；根元素属性供 CSS 消费。
  切换偏好不会以 React key 重建页面。偏好只保存在本机，存储失败仍可使用当前会话内的外观。
- 全局样式不再声明第二套浅色／深色调色板。新增组件应直接使用
  `--text`、`--surface`、`--soft`、`--line`、`--control`、`--direct`、`--shared` 等语义值。
  控件上的正文配对使用 `--on-direct`／`--on-shared`，不要固定白色。

## 文件归属

| 文件 | 当前职责 |
| --- | --- |
| [styles.css](../../styles.css) | 文档基础、入口、P2P、Workspace 壳层、现有领域页面与响应式布局 |
| [workspace-chat-enhancements.css](../../workspace-chat-enhancements.css) | 消息定位、作者提及、图片缩放等聊天局部行为的视觉反馈 |
| [workspace-auto-hide.css](../../workspace-auto-hide.css) | 本人消息自动隐藏设置与提示 |
| [primitives](../primitives) | 按钮、Switch、Select、Slider、选中项、动作菜单等共用控件 |
| [features/settings/settings.css](../../features/settings/settings.css) | 个人设置分类导航、主内容、外观选项与保存反馈 |
| [features/members/member-picker.css](../../features/members/member-picker.css) | 邀请成员的搜索、多选、提交反馈及独立对话框 |
| [features/conversation/conversation.css](../../features/conversation/conversation.css) | 共用会话视图的横幅插槽、隐藏输入区及不可编辑说明 |
| [features/topics/topics.css](../../features/topics/topics.css) | 话题新建表单、领域横幅及同步选项；消息与输入区使用共用会话样式 |
| [workspace-bot-chapters.css](../../workspace-bot-chapters.css) | Bot 资料、连接、授权、凭据四章节及嵌入布局 |
| [workspace-echo-management.css](../../workspace-echo-management.css) | Echo 需求与公开征集同级入口、筛选及正文滚动 |

在原有选择器所在的章节修改领域布局，保留权限、传输、菜单、分页、内容隐藏等状态规则。
新增共用控件由 primitives 管理；不要在全局末尾再建立一套控件皮肤。
正式页面不导入设计报告的 HTML、CSS 或演示脚本。

## Workspace 布局

`.workspace-product-shell` 是布局容器，`.workspace-rail` 使用 `display: contents`，
让已有侧栏中的导航、标题、列表和账户区分别进入同一张网格：

- 超过 1100px：72px 导航轨、288px 列表、弹性正文、可选 360px 详情。
  `.context-hidden` 去掉详情列。
- 761–1100px：72px 导航轨、260px 列表、正文；详情浮于右侧，并有独立滚动和阴影。
- 只有聊天和话题保留可折叠的中间列表；文件和成员使用单一主列表。个人与空间设置使用导航轨加完整主内容。
- 不超过 760px：单主窗格；普通成员根导航为五项，owner/admin 增加空间成为六项，内容预留底栏与安全区空间。
  会话正文、话题正文、详情和个人设置子页隐藏底栏。

手机切换正文／详情时只隐藏 `.workspace-rail-header`、`.workspace-rail-content`、
`.workspace-rail-footer`，不隐藏包含根导航的整个 `.workspace-rail`。
桌面详情正文独立滚动，手机详情为整页；未选对象不呈现先前会话的详情。
主内容、列表和详情都允许自身滚动；页面壳层保持视口高度。
路由与返回状态由应用协调层管理，CSS 不选择会话或改写发送目标。

## 消息、材质与状态

- Workspace 消息正文为 15px／1.65 行高。人物头像圆形，群与工具实体使用圆角方形。
  消息按平面阅读列表排列，本人消息使用 `--message-self` 柔和底色，连续消息及悬停时仍与他人消息区分。
- 连续消息只在组首／组尾保留圆角，中间平直接合；组内没有横向缝隙，普通相邻组间隔 12px。
  共享会话视图按作者身份、时间和语义边界计算分组，不用 CSS 猜测相邻作者。
  悬停只强调当前一行，各消息仍保留独立节点、操作和键盘焦点。
- 桌面消息操作在指针悬停／焦点进入时显示于同一行第三列，背景透明并占据布局空间。
  正文不会被覆盖，悬停也不改变可用宽度；桌面快捷按钮保持 30px。
  手机保留 44px 的可见更多入口；表情触发按钮隐藏，但其菜单锚点与弹层仍保留。
- 选中导航和列表项使用独立 2px 标记，与 10px 圆角内容面相隔 5px。
  文件筛选和类别使用底部标记。操作焦点另有轮廓，不能只依赖选中颜色。
- P2P 等待邀请属于消息列表；会话详情单独限制高度并滚动，不能溢出覆盖正文。
  编辑器与 Workspace 共用语义材质，操作强调色仍属于私密通道。
- 不透明模式把玻璃材质解析为实色并将模糊设为零。
  `data-motion="reduced"` 同时约束现有动画与过渡，保留最终状态与焦点。
- 紧凑密度调整已接入的会话行、消息行和空间变量，不缩小正文字号或触控命中区。

## 验证边界

主题单元测试覆盖偏好正常化、旧键迁移、无效数据、存储异常、系统解析、跨标签同步，
以及全部主题明暗配色的正文与通道按钮配对对比度。生产样式应同时通过 PostCSS 解析与差异检查。

本次样式调试通过本地 Vite 渲染真正的 React 入口、聊天、根导航、成员、话题空态、
文件空态、个人外观设置及 P2P 等待／详情，检查桌面、平板、手机和六套配色。
其中 Workspace 与 P2P 截图使用受控 API／WebSocket 数据，只证明这些视觉状态的布局；
它们不证明真实权限、消息投递、传输、保存或服务端行为。
真实 Go 与 PostgreSQL 集成验证由项目
[测试与发布规范](../../../../../docs/development/TESTING_AND_RELEASE.md) 管理。
首轮样式统一后的结构调整和本轮检查见
[页面精修记录](../../../../../docs/design/ui-ux-rewrite/PAGE_REFINEMENT.md)，后续话题／群聊共用视图与头像、消息细节见
[会话一致性修正](../../../../../docs/design/ui-ux-rewrite/CONVERSATION_PARITY.md)；未验收平台不由合成数据截图代替。
