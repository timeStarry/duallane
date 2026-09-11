# 最终提交与 PR 验证

日期：2026-09-11。分支：`codex/ui-ux-rewrite-plan`；重构前基线 `ef51873`（0.18.0）。
已验证代码提交：Go 与领域契约 `59c6930`，正式前端及回归 `5148eb3`。
本文是本次提交的证据记录，不另定义 UI/UX 规则。规则入口为 [最终规范](README.md)，
后续补充的归属和回归映射见 [覆盖账本](COVERAGE.md#后续评审要求归档)。

## 提交范围与规范整理

- 一套正式主题／组件／工作台与页面布局，保持 P2P 和 Workspace 独立数据边界。
- 话题使用常规消息模型、内容、发送与操作；Go API 兼容扩展，不增加数据库迁移。
- 后续所有已采纳反馈进入设计系统、体验流程或对象／设置规范；旧相反表述已替换。
- 历史三主题原型与阶段验证保留但明确非规范；当前验收使用五套主题，各有浅深模式。
- 组件 README 记录接口与检查，规范从唯一归属引用，不再维护另一组视觉数值。

## 安全与兼容审查

后端提交 `59c6930` 复用 Go 普通消息服务和话题事务适配；话题正文不进入普通群消息流。
空间、父群和话题访问、关闭状态、消息幂等、附件配额、保留与无内容审计继续在服务端执行。
话题附件先进入 private_staging，发布后按当前话题访问授权，包括上传者。主题偏好不保存
会话内容，P2P 正文及邀请 `#k=` 不进入服务器持久化或日志。

独立 PR 审查补充修复跨父群话题并发认领同一 staging 附件的问题：所有附件 ID 去重排序后，
在校验前获取与删除路径相同的事务锁并持有至提交。新 PostgreSQL 回归先稳定复现两次成功，
修后验证只有一个话题关联、另一个收到既有 invalid_attachment 错误并产生拒绝审计；
逆序输入也按同一实际 PostgreSQL 锁顺序等待，不放宽授权或引入新存储归属。

全套 UI 回归还复现了消息菜单自动关闭：历史前插／分组变化触发程序性滚动，旧判断以触发器
位移超过 1px 视为用户滚动。现在对象菜单区分实际滚动输入与程序性补偿；保持同一有效目标，
按钮锚点更新位置、右键点位保持稳定。滚轮、触控、滚动键、滚动条操作仍关闭菜单，
目标移除或作用域变化也关闭；菜单内键盘导航不误触发。Select 的原关闭策略保持不变。

随后的完整回归复现了早期记录过的 382.375px 阅读锚点跳动：历史 HTTP 响应在实时追加的
DOM 提交后、其被动副作用前完成，旧提交提前清除了新的分页快照。正式 App 的受控网络
时序回归稳定证明旧版位移 4128.5px；改为 layout 阶段补偿，并确认本批历史消息已进入当前
渲染后才消费快照，修复后保持原有 ≤1px 断言。真实 E2E 的 ≤2px 断言未改动。
该测试只观察实际提交并控制合法的网络交付时序，不替换生产 React 调度或滚动逻辑。

## 验证环境与已完成检查

Windows 工作区使用固定 pnpm 10.30.3；Go 编译及 PostgreSQL race 通过原有 Linux 容器执行。
浏览器数据均为合成内容。Workspace 使用独立 `duallane_ui_conversation_03` 测试库，
前端／API 端口 5199／8899；P2P 浏览器前端／API 为 5173／8787。
用户预览 5198／8898 不参与测试数据写入。

| 检查 | 命令与结果 |
| --- | --- |
| 单元测试 | `corepack pnpm test`：Web 43 文件／333 项、SDK 8 项、离线兼容 20 项通过；离线兼容 PostgreSQL 专项 1 项按原配置跳过，未修改该包。 |
| 类型与构建 | `corepack pnpm lint`、`corepack pnpm build` 通过。CSS 281.18 kB（gzip 42.56），主 JS 1293.76 kB（gzip 382.95）；主包体积提示保留。 |
| Go 静态与基础门禁 | `make -C apps/backend verify` 全项通过，含生成检查、单元、race、vet、staticcheck、govulncheck 和 build。当前代码未命中可调用漏洞；扫描仍报告未调用的依赖漏洞，不宣称依赖零告警。 |
| PostgreSQL | 话题完整管线阶段已通过 `make -C apps/backend integration-postgres` 全仓门禁；最终附件锁补丁后重跑相关 8 包全 PG-race 和新并发回归，后者多轮通过。 |
| P2P 浏览器 | `corepack pnpm exec playwright test --config .private-test-results/ui-runtime/p2p.config.ts`：7/7 通过，覆盖 IME、邀请片段、退出取消、文本／文件、移动布局、加密回退和重建。 |
| Workspace 浏览器 | `corepack pnpm exec playwright test --config .private-test-results/ui-runtime/pr-ready.config.ts`：完整 42/42 通过（6.9 分钟），包括先前失败的菜单、历史锚点、双用户流程及 8 项完整话题回归。单 worker，无失败重试。 |
| 菜单与阅读历史专项 | `node apps/web/src/ui/patterns/verify-menu-layout-scroll.mjs`、`node apps/web/src/ui/patterns/verify-workspace-history.mjs` 通过，覆盖程序性重排、真实滚动、焦点、移除／撤权、历史前插与失败重试。 |
| 正式组件工作台 | `node apps/web/src/ui/workbench/verify.mjs`：40 组矩阵、Chromium 触控以及 Firefox／WebKit Select 检查通过。 |
| 文档 | `node docs/design/ui-ux-rewrite/verify-docs.mjs`：32 份规范及实现说明的 504 处本地链接和 Markdown 章节引用通过，已加入 CI；`git diff --check` 通过。 |

最终附件锁补丁的 Go 命令在 `apps/backend` 下运行，使用显式可丢弃 PostgreSQL：

```sh
go test -count=3 -race -tags postgres_integration ./internal/workspace/messageblocks -run TestPGTopicStagingAttachmentHasOneScopeUnderConcurrentSend
go test -count=1 -race -tags postgres_integration ./internal/workspace/messageblocks ./internal/workspace/messages ./internal/workspace/topics ./internal/workspace/files ./internal/workspace/conversations ./internal/workspace/emotes ./internal/workspace/events ./internal/workspace/httpapi
make verify
```

菜单修改前的完整 Workspace 回归为 40 通过／2 失败，两条均由前述自动关闭造成；修复后两条菜单路径通过。
下一轮为 41 通过／1 失败，复现上述阅读锚点竞争；修复后的最终全套为 42/42 通过，原失败 trace 保留在忽略目录。
历史专项曾发现 503 测试响应在下一次观察器加载时错误变成“空历史”，从而触发真正的列表终态布局；
已修正合成响应的失败持续性，保留原有 1px 正文锚点断言，没有以增大容差替代修复。

正式可复现的 Go Workspace 门禁为 `pnpm test:e2e:workspace-go`，使用测试与发布文档要求的
显式可丢弃 PostgreSQL 和 schema 创建许可。本地为保留预览使用私有 config 的
5199／8899 覆盖；没有借用退休 Node API。私有配置与原始日志不随 PR 发布。

## 视觉证据与发布边界

已人工检查桌面、390px、320px 正式组件与页面截图，包含外观、消息、话题详情、成员和管理页。
[精选评审截图](review/README.md) 是正式 App 的合成数据证据；其余原始产物留在忽略目录。
发布前仍须完成人工真机软键盘、安全区域、辅助技术，以及覆盖账本中尚未核销的完整矩阵。
自动化浏览器截图不能替代这些检查。

主包超过 500 kB 的构建提示仍存在，全面输入／滚动／内存性能基准未完成，不宣称已解决。
先前阶段未稳定复现的阅读锚点波动已在本轮确定性定位并修复，历史记录保留当时的证据边界；
当前结论以前述原因、专项和最终回归为准，不通过放宽容差掩盖。

没有版本号变更、schema 迁移或生产部署；用户说明保留为 [待发布说明](RELEASE_NOTES.md)，
正式发布时分配版本并同步既有 release catalog，不修改已发布 0.18.0 的历史条目。
部署需新 Web 与 Go API 同版通过健康／就绪及关键流程检查；回退使用已验证的整版镜像和
原数据权威，不回退到旧 CSS 或退休在线服务。维护者 `timestarry` 决定合并，合并不授权部署。
