# Workspace Agent Bot Platform Requirements

## 1. 文档定位

本文定义 DualLane 共享空间（Workspace）的 Agent Bot 平台能力，汇总并约束以下关联功能：

- 用户自定义 Agent Bot 接入。
- Hermes / OpenClaw 等外部 Agent Runtime 的低门槛连接。
- 可扩展的结构化消息卡片，并兼容受控的飞书 Card JSON 子集。
- 统一、安全、可审计的 Bot 指令与卡片操作体系。
- Bot 专属 API、Token、Scope、授权和撤销管理。
- 与现有 Workspace 消息、会话、成员、RBAC、实时事件、配额、审计和日志脱敏的集成。

本文是需求和架构契约，不是某个 Agent 框架的插件实现说明。Workspace 负责安全的消息渠道和授权边界；Hermes、OpenClaw 或其他 Agent Runtime 负责模型、记忆、工具和 Agent 循环。

## 2. 现状与设计结论

当前代码已经具备以下基础：

- `users.kind` 支持 `human`、`bot`、`system`。
- Workspace 消息使用版本化结构化协议 `duallane.message+json;v=1`。
- 消息目前支持 `text`、`mention`、`link`、`emoji`、`attachment` 块。
- 消息服务端负责规范化、成员校验、附件校验、幂等和 `plainText` 摘要。
- 会话成员、Capability、实时事件和 Workspace 审计链路已存在。
- Bot 不能被当作普通用户通过 OAuth 或 Session 登录，这一约束必须延续。

当前尚未具备：

- 外部 Agent 长连接 Gateway。
- Bot 专用 Token 和 Scope 管理。
- 卡片引用块、卡片注册表、卡片操作和卡片版本投影。
- 指令注册、解析、执行、工作流和命令幂等。
- Agent 事件续传、消费确认、连接状态和广播投递管理。

核心设计结论：

1. **Agent Runtime 外置**：不要把 Hermes/OpenClaw 的模型和工具循环写进 Workspace 核心。
2. **Gateway 统一**：所有外部 Agent 通过一个版本化 Bot Channel Gateway 接入。
3. **卡片受控兼容**：支持飞书 Card JSON 的安全子集和映射层，不直接执行任意飞书 JSON。
4. **命令统一执行**：文本指令、卡片按钮、外部 Agent API 调用进入同一授权和领域服务管线。
5. **权限最小化**：Bot Token 代表 Bot，不代表 Bot 所有者；上下文、文件和工具权限分别授权。

## 3. 产品范围与非目标

### 3.1 范围

- 每个用户在一个 Workspace 中最多配置一个自有 Bot；系统 Bot（如“信标”“回声”）不受此上限影响。
- Bot 统一绑定外部 Agent Runtime；模型、工具、记忆和调用费用由外部 Agent 负责。
- 默认仅创建者可见、可私聊、可触发。
- 所有者可以将 Bot 开放给指定成员、全部空间成员，或允许经批准加入群聊。
- 外部 Agent 通过 WebSocket 长连接优先，Webhook 作为后续可选方式。
- 支持文本、回复、有限上下文、卡片发送/更新和按 Scope 授权的附件操作。
- 公开提供 Hermes/OpenClaw 一键安装所需的固定 Prompt 和接入说明。

### 3.2 非目标

- 不允许用户上传或执行任意 Bot 代码。
- 不允许普通 Bot Token 登录 Workspace 或模拟用户。
- 不默认开放联网、代码执行、任意 Webhook、任意 URL 请求或数据库访问。
- 不直接兼容所有飞书组件和事件语义。
- 不承诺飞书卡片 JSON 与 DualLane DOM 100% 等价。

## 4. Bot 生命周期与身份

### 4.1 Bot 类型

用户自定义 Bot 只有一种运行模式：`external_agent`。Hermes、OpenClaw 或其他外部 Agent Runtime 自行管理模型、Provider Key、工具、记忆和 Agent 循环；DualLane 只提供受控消息渠道和权限边界。

系统 Bot（如“信标”“回声”）是由 DualLane 内部服务驱动的系统身份，不能与用户 Bot 混淆，也不适用用户 Bot 的外部连接配置。

### 4.2 创建与删除

- 创建者必须是有效 Workspace 成员。
- 每个用户在每个空间最多一个自定义 Bot；并发创建由数据库唯一约束保证。
- 创建时默认 `private`、仅创建者可私聊、禁止入群、仅 `@Bot` 或指令触发。
- Bot 采用稳定 ID 和 `kind: "bot"`。
- Bot 名称不得冒充系统 Bot“信标”“回声”或平台保留名称。
- 删除采用“停用 -> 清理”的两阶段流程，避免正在执行的事件和请求失控。
- 删除不会自动删除普通 Workspace 消息；Bot 关联配置、Token、工作流和外部连接必须撤销。

### 4.3 官方标识

成员列表、会话列表、消息作者、卡片来源和群成员列表必须展示服务端投影的 `BOT` 标识。创建者可显示为“由某某创建”，但不能替代官方标识。

## 5. Bot 所有者可配置项

设置页面按四组组织，不把所有开关堆在一个表单中。

### 5.1 身份与发现

- 名称、头像、简介、欢迎语。
- 可见范围：仅自己、指定成员、空间成员、仅所在群聊。
- 是否允许发起私聊。
- 私聊允许名单。
- 是否允许被搜索。
- 是否允许显示创建者身份。

默认值必须最保守：仅自己可见、仅自己可聊。

### 5.2 会话与群聊

- 是否允许被加入群聊。
- 邀请者：所有者、群管理员、任意成员。
- 是否需要所有者确认。
- 是否允许主动发言。
- 触发方式：`@Bot`、注册式指令；首期不开放每条消息触发。
- 每个用户每分钟和每日请求上限。
- 群聊最大上下文消息数、Token/字符数和时间范围。
- 是否包含回复引用、系统消息、附件元数据。
- 是否允许读取附件文本预览或完整内容。
- 是否启用跨消息长期摘要。默认关闭。

有效上下文取以下限制的交集：

```text
系统上限 ∩ 空间策略 ∩ 群策略 ∩ Bot 所有者配置 ∩ Bot Token Scope
```

群成员在 Bot 加入、策略变更和首次触发时必须能看到上下文范围说明。

### 5.3 Agent 连接

- 运行模式固定为外部 Agent Runtime。
- WebSocket 连接状态、最近心跳、最近处理时间。
- Token 创建、轮换、撤销和 Scope。
- 外部 Agent Adapter 版本和连接错误。
- 是否暂停外部调用。

### 5.4 预算与限流

- 每分钟请求数。
- 每个成员每日请求数。
- 输入和输出 Token 上限。
- 最大并发数。
- 外部 Agent 事件积压上限。
- 达到上限后的行为：拒绝、排队或仅返回提示。

平台不得在无法可靠计价时展示虚假的金额预算；首期以请求数、Token 和并发数为准。

## 6. 外部 Agent Channel Gateway

### 6.1 接入流程

1. 用户创建 `external_agent` Bot。
2. 设置身份、可见性、群聊和上下文策略。
3. 生成一次性 Bot 接入 Token。
4. 安装 Hermes/OpenClaw Adapter。
5. 填写 DualLane 地址和 Token。
6. Adapter 建立 WebSocket、完成鉴权和能力协商。
7. 用户在允许范围内与 Bot 私聊或将 Bot 加入群聊。

接入配置目标：

```yaml
channels:
  duallane:
    url: https://duallane.example.com
    bot_token: dl_bot_xxx
```

### 6.2 传输方式

首选 WebSocket 长连接，由 Agent 主动连接：

```text
Hermes/OpenClaw -> WebSocket -> DualLane Gateway
```

这样不要求用户为 Agent 配置公网入口。Webhook 作为后续能力，必须具备签名、时间戳、nonce、重放保护、幂等事件 ID、超时和地址策略。

### 6.3 连接状态

平台展示：

- 已连接、断开、已暂停、已撤销。
- 最近心跳和最近成功处理时间。
- Adapter 版本。
- 待处理事件数量。
- 最近一次标准化错误。

断线期间仅保留有限事件窗口。恢复连接后按序号续传；超出窗口则要求 Agent 重新同步，不允许无限积压。

### 6.4 事件确认与幂等

每个事件包含：

```json
{
  "version": 1,
  "eventId": "evt_xxx",
  "sequence": 1024,
  "type": "message.created",
  "botId": "bot_xxx",
  "conversationId": "conv_xxx",
  "trigger": { "type": "mention" },
  "payload": {}
}
```

Agent 必须确认接收；事件处理和回复使用独立幂等键。重复事件不会重复调用模型、发送回复或执行状态变更。

首期事件：

- `message.created`
- `bot.mentioned`
- `command.invoked`
- `card.action`
- `conversation.bot_added`
- `conversation.bot_removed`
- `connection.test`

事件在投递前执行会话成员、Bot 可见性、上下文策略和 Token Scope 过滤。

## 7. Agent Gateway API

建议使用 `/api/bot-gateway/v1` 独立命名空间，避免 Bot Token 进入普通 `/api/workspace` Session 逻辑。

### 7.1 连接与凭据

```text
POST   /api/workspace/bots
GET    /api/workspace/bots/{botId}
PATCH  /api/workspace/bots/{botId}/settings
POST   /api/workspace/bots/{botId}/tokens
GET    /api/workspace/bots/{botId}/tokens
POST   /api/workspace/bots/{botId}/tokens/{tokenId}/revoke
POST   /api/workspace/bots/{botId}/connection/test
POST   /api/workspace/bots/{botId}/pause
POST   /api/workspace/bots/{botId}/resume
DELETE /api/workspace/bots/{botId}
```

这些管理接口使用当前用户 Session，并执行 `bot.configure_own` 等 Capability。

### 7.2 外部 Agent 操作

```text
GET    /api/bot-gateway/v1/me
POST   /api/bot-gateway/v1/events/ack
GET    /api/bot-gateway/v1/conversations/{id}/context
POST   /api/bot-gateway/v1/messages
POST   /api/bot-gateway/v1/cards
PATCH  /api/bot-gateway/v1/cards/{cardId}
GET    /api/bot-gateway/v1/attachments/{id}
POST   /api/bot-gateway/v1/attachments
POST   /api/bot-gateway/v1/typing
```

Bot Token 只能代表绑定的 Bot 和空间，不能代表创建者。所有操作继续执行 Bot Scope、会话成员、资源可见性、群策略和系统上限。

### 7.3 Scope

建议最小 Scope：

```text
messages:read_trigger
messages:read_context
messages:send
cards:write
cards:act
files:read_metadata
files:read_preview
files:read_content
files:write
commands:receive
```

默认只授予 `messages:read_trigger`、`messages:send` 和 `commands:receive`。完整文件内容、卡片操作和上下文读取必须显式授权。

## 8. 固定 Prompt 与一键安装

### 8.1 目标

为 Hermes/OpenClaw 提供一个可直接复制或由 Adapter 自动读取的静态安装 Prompt，使用户无需手工理解完整 Channel API。

### 8.2 固定地址

建议固定地址：

```text
https://duallane.tsio.top/integrations/hermes/duallane-channel.md
https://duallane.tsio.top/integrations/openclaw/duallane-channel.md
https://duallane.tsio.top/integrations/duallane-channel.md
```

地址必须由部署版本提供，并支持：

- 稳定主地址，内容指向当前推荐版本。
- 显式版本地址，例如 `/v1/duallane-channel.md`。
- `ETag`、`Last-Modified` 和内容哈希。
- 不包含用户 Token、内部地址或私密部署信息。
- 文档变更有版本号和兼容性说明。

### 8.3 Prompt 内容

静态 Prompt 只能描述：

- 如何安装或启用 Channel Adapter。
- 如何配置 DualLane URL 和 Bot Token。
- 事件、回复、卡片和错误协议。
- 默认 Scope 与隐私边界。
- 不得读取未授权上下文、文件或其他会话。
- 断线重连、事件确认和幂等要求。

Prompt 不是授权材料，也不能赋予 Agent 新 Scope。用户 Token 必须由 DualLane 管理页面生成，不能写入静态 Prompt 或仓库。

### 8.4 一键安装安全

如果 Hermes/OpenClaw 支持远程安装 Prompt，安装器必须展示来源、版本和将写入的配置；不应静默执行任意脚本。推荐先提供固定 Prompt + 官方 Adapter 包，再由用户确认安装。

## 9. 可扩展消息卡片

### 9.1 基础协议

在现有 Workspace 消息块上增加卡片引用：

```json
{
  "type": "card",
  "cardId": "card_xxx",
  "cardType": "feishu.adaptive.v1",
  "schemaVersion": 1,
  "fallbackText": "回声：新的需求征集"
}
```

卡片实例单独保存类型、版本、资源引用、修订号、可见性和失效状态。消息只保存卡片引用和降级摘要，避免把可变投票数、需求状态复制到历史消息中。

### 9.2 飞书 JSON 兼容策略

采用“兼容安全子集 + 映射层”，不直接把任意飞书 JSON 当作浏览器 DOM 或脚本执行。

首期支持：

- `config` 中的基础版本和宽度配置。
- `header`、`div`、`markdown`。
- `note`、`hr`。
- `button`、`button_list`。
- `action` 与有限参数。
- `columns` 的受控布局。

首期不支持或默认拒绝：

- 任意 URL 回调。
- `js`、脚本、HTML、远程组件。
- 任意图片代理或未授权资源。
- 未注册动作。
- 动态表达式、模板执行和服务端函数名。
- 超过深度、节点数、文本字节数的卡片。

飞书卡片动作统一映射为 DualLane `card action`，必须经过本地注册表、Scope、会话成员、资源状态、幂等和审计管线。飞书 JSON 只是输入格式，不是权限格式。

### 9.3 卡片注册表

每个 `cardType + schemaVersion` 注册：

- 输入校验器。
- 公开投影器。
- 降级文本生成器。
- 动作定义及参数 Schema。
- 前端渲染器或兼容渲染器。
- 版本升级和未知版本行为。

未知卡片必须显示 `fallbackText`，不能使消息列表崩溃。

### 9.4 卡片动作

```json
{
  "version": 1,
  "clientActionId": "act_xxx",
  "cardId": "card_xxx",
  "actionId": "vote",
  "expectedRevision": 7,
  "input": {}
}
```

动作服务端执行：输入校验、身份推导、会话成员校验、资源可见性、Capability、状态、修订号、幂等、领域事务、事件和审计。

## 10. BOT 安全命令体系

### 10.1 注册式命令

Bot 通过服务端注册命令定义：

```ts
type BotCommandDefinition = {
  botId: string;
  name: string;
  aliases?: string[];
  version: number;
  allowedContexts: Array<"bot_direct" | "group_mention">;
  requiredCapability?: string;
  argumentSchema: unknown;
  handler: string;
};
```

用户自定义 Bot 不允许上传脚本。用户可配置指令名称、说明、参数 Schema 和提示模板，但最终执行只能调用已注册的安全 Handler。

### 10.2 识别规则

- 仅在 Bot 私聊或明确 `@Bot` 的群聊上下文识别斜杠命令。
- 普通人类会话中的 `/list` 等文本保持普通消息语义。
- 命令名称、别名、参数数量和长度受限。
- 不解析 Shell、SQL、JavaScript、模板表达式或任意路径。
- 未知命令返回帮助，不泄露内部 Handler 或权限细节。

### 10.3 统一执行管线

文本命令、卡片按钮和外部 Agent API 必须收敛到同一执行管线：

1. 校验协议和输入 Schema。
2. 从 Session 或 Bot Token 推导真实身份。
3. 校验空间、会话、成员和 Bot Scope。
4. 加载目标卡片/资源并重算可见性。
5. 校验 Capability 和当前状态。
6. 校验幂等键和资源修订号。
7. 执行领域服务事务。
8. 写入审计和过滤后的实时事件。
9. 返回当前调用者可见的投影。

按钮是否显示、Prompt 是否要求 Agent 不执行某操作，都不能代替服务端授权。

### 10.4 安全限制

禁止客户端或 Agent 提交并被信任：

- actorId、ownerId、role、kind、capability。
- 卡片官方状态、投票数、发布者。
- 消息作者 kind=bot。
- 审计 actor、target 和 result。
- 跨会话上下文或文件路径。

## 11. API 授权与管理模型

### 11.1 用户管理 API

当前用户 Session 管理自己的 Bot：

```text
bot.create_custom
bot.configure_own
bot.rotate_token
bot.pause_own
bot.delete_own
```

空间主人可通过空间策略控制：

```text
bot.policy.manage
bot.external_connection.allow
bot.custom_endpoint.allow
bot.group_invitation.override
```

群管理员可以管理 Bot 在本群的加入、移除和群策略，但不能读取 Bot 所有者未授权的私聊或全局配置。

### 11.2 Bot Token

- Token 只显示一次，数据库只保存哈希。
- Token 绑定一个 Bot、一个空间和明确 Scope。
- 支持过期、撤销、轮换和最后使用时间。
- 不得用于普通 Workspace 登录。
- API 返回掩码，不返回完整 Token 或 API Key。
- 连接测试和异常响应不得泄露 Token、LLM Key 或上游完整错误。

### 11.3 外部 Agent 凭据边界

DualLane 不保存用户的 LLM API Key、Provider Key 或外部 Agent 内部凭据。DualLane 只保存 Bot Gateway Token 的哈希、Scope、状态、创建时间和最后使用时间。外部 Agent Runtime 自行管理模型密钥；这些密钥不得通过消息、卡片、命令、Prompt 或 Gateway API 传入 DualLane。

## 12. 运行时与文件权限

Bot 上下文和文件权限分级：

- `messages:read_trigger`：仅读取触发消息。
- `messages:read_context`：按限制读取已授权历史。
- `files:read_metadata`：文件名、类型、大小、时间等。
- `files:read_preview`：服务端生成的文本预览。
- `files:read_content`：完整内容，必须显式授权并审计。
- `files:write`：上传文件，继续执行 Workspace 配额。

首期默认关闭完整文件读取、联网、代码执行和任意工具调用。

Bot 不得读取未加入的会话；Bot 所有者也不能因为拥有 Bot 获得 Bot 所在群聊之外的内容。

## 13. 审计、日志与数据保护

可记录：Bot、命令、卡片类型、资源 ID、动作、结果、错误码、时间、连接状态和用量统计。

不得记录：需求正文、私密上下文、附件内容、下载密钥、Session、OAuth、Bot Token、Provider Key 和完整上游响应。

## 14. 应用侧群聊安全门禁、异常调用与频控

群聊中的 `@Bot` 不要求必须由 Bot 所有者本人发起。允许的群成员可以触发 Bot，但每条消息必须先经过 DualLane 应用侧门禁；未通过门禁的消息不得发送给外部 Agent，也不得用 Agent 判断是否允许。

门禁顺序固定为：

1. 确认 Workspace 已启用、会话存在且类型允许 Bot 参与。
2. 确认 Bot 仍处于启用状态，并已正式加入该群聊。
3. 确认发送者是当前有效群成员，且未被禁言、移除或限制使用 Bot。
4. 确认消息确实是允许的触发形式，例如明确 `@Bot` 或已注册命令；普通提及、引用文本和转发内容不能自动变成触发。
5. 在应用侧执行成员、群策略、Bot 可见性、内容长度、附件类型、上下文范围、Token Scope、频控和风险规则。
6. 生成最小化的 Agent 事件，只包含通过策略筛选的触发消息和必要上下文。
7. 通过门禁后才投递给外部 Agent Gateway。

以下情况直接在应用侧拒绝、静默丢弃或返回本地固定提示，不与 Agent 交互：Bot 未入群、发送者无权触发、会话类型不允许、消息不是合法 `@Bot`/命令、超过长度或附件限制、超过频控、Bot 已熔断、Token Scope 不足、上下文不可见、资源已删除或请求存在重放冲突。

应用侧门禁必须是确定性代码和服务端策略，不能由 Prompt、Agent Runtime 或外部模型覆盖。Agent 返回“允许”“忽略”或“需要权限”也不能改变 DualLane 已作出的拒绝决定。

异常调用和频控同时按系统、空间、Bot、Token、会话、成员、命令/卡片动作和外部连接实例计数，取最严格结果。需识别突发请求、重复事件/回复、群聊多成员放大触发、频繁重连、持续超时或错误、上下文突然扩大、重复附件读取和单一成员异常消耗。

处理按风险递进：正常令牌桶限流、降低成员额度、限制高成本上下文和文件能力、暂停事件投递与发送的可恢复熔断、撤销异常 Token。熔断需要冷却时间、恢复条件和所有者手动暂停/恢复入口；单次上游错误不得永久封禁 Bot。

资源放大保护要求：一条消息默认最多一次 Agent 调用；同一事件只能产生一次逻辑回复；流式回复有最大时长、字节数和更新频率；群聊触发有最大并发；上下文、附件和卡片更新分别计数。监控只记录请求数、拒绝数、延迟、错误率、重连、积压、上下文大小、附件读取次数和熔断状态，不记录正文。

需要审计的操作：

- Bot 创建、配置、暂停、删除。
- Token 创建、轮换、撤销。
- Bot 加入或移出群聊。
- 上下文和文件权限变更。
- 命令或卡片动作成功、失败和拒绝。
- 完整文件读取和外部连接测试。
- 广播、重复事件和投递失败。

## 15. 部署与固定资源

- Workspace 仍由 `WORKSPACE_ENABLED=true` 控制，默认关闭。
- 固定 Prompt 可以作为 Web 静态资源或独立版本化资源部署。
- Prompt 地址不承载秘密，部署到 CDN 或反向代理时可缓存。
- Gateway WebSocket、普通 Workspace WebSocket 和 P2P 信令必须保持清晰路由边界。
- PostgreSQL 持久化 Bot、Token 哈希、Scope、卡片、命令执行、工作流、连接和投递元数据。
- Token 哈希和消息正文按现有安全与保留策略处理；LLM Key 留在外部 Agent，P2P 内容不得进入这些表。

### 15.1 系统 Bot 与用户 Bot 的 UI 区分

系统 Bot 与用户创建的 Bot 必须在视觉、来源和设置入口上明显区分：

| 项目 | 系统 Bot | 用户自定义 Bot |
| --- | --- | --- |
| 来源标签 | `DualLane 系统` | `由 {创建者} 创建` |
| 标识 | `SYSTEM BOT` | `USER BOT` |
| 头像 | 平台统一头像，不可编辑 | 所有者可配置，但保留 Bot 标识 |
| 设置入口 | 不显示用户配置入口 | 仅创建者显示“我的 Bot”管理入口 |
| 权限说明 | 平台固定规则 | 显示所有者、Scope、连接状态和可见范围 |
| 群聊操作 | 由产品规则决定 | 显示邀请审批、所有者和当前群策略 |

系统 Bot 不出现在“创建我的 Bot”列表中；用户 Bot 不得使用系统 Bot 的名称、头像、徽章颜色或固定说明。成员列表、会话列表、消息作者、卡片来源和群成员详情均显示来源标签，避免把用户 Agent 误认为平台官方能力。

## 16. 分阶段实施建议

### P0：可安全接入

- Bot 生命周期、官方 BOT 标识和每用户一个约束。
- Bot Token、Scope、撤销和连接状态。
- WebSocket Gateway、事件确认、重连和有限续传。
- 文本消息接收与发送。
- OpenClaw/Hermes 通用 JavaScript SDK。
- 固定 Prompt 地址和版本化安装说明。
- 上下文限制和审计基础。

### P1：通用交互能力

- 卡片引用块和注册表。
- 受控飞书 JSON 子集转换器。
- 卡片发送、更新和卡片动作。
- 注册式命令和多步骤工作流。
- 群聊加入审批、成员策略和文件元数据访问。
- OpenClaw 官方 Adapter。

### P2：增强能力

- Hermes 官方 Adapter。
- Webhook Gateway。
- 流式消息更新。
- 文件文本预览和受控完整文件读取。
- 更完整的外部 Agent Adapter、Webhook 和流式协议能力。

## 17. 测试与验收

### 身份与授权

1. 每个用户每个空间最多创建一个自定义 Bot，竞争创建不会产生重复记录。
2. Bot 不能通过 OAuth、Session 或普通用户接口登录。
3. Token 只能访问绑定 Bot、空间和 Scope 内的资源。
4. Token 撤销后现有连接和请求立即失效。
5. Bot 所有者、群管理员、普通成员的操作边界符合策略。

### Gateway

6. WebSocket 鉴权、心跳、断线重连、事件确认和有限续传可用。
7. 重复事件和重试不会重复调用、发消息、执行命令或写状态。
8. 事件只投递给 Bot 有权访问的会话和内容。
9. 群聊中除所有者外的合法成员可以按策略通过 `@Bot` 触发；不合法、非触发、超限或风险消息在应用侧被拒绝且不进入 Agent。
10. 事件重复、群聊放大、异常重连和持续错误会触发分层限流、告警和可恢复熔断。

### 卡片

11. 现有五类消息块保持兼容。
12. 未知卡片类型和版本可用 fallbackText 展示。
13. 飞书受控子集可校验、转换、渲染和操作。
14. 任意脚本、HTML、未注册动作、私网 URL 和超限卡片被拒绝。
15. 卡片按钮和等价指令使用相同授权、幂等和领域逻辑。

### 命令

16. 普通会话中的命令文本不被误执行。
17. 未知命令、错误参数、过期工作流和权限拒绝返回稳定错误码。
18. 命令不能执行 Shell、SQL、动态代码或任意文件操作。

### 隐私与运维

19. Agent 不能读取未加入会话、未授权文件或其他用户私聊。
20. P2P 明文不进入 Workspace 消息、卡片、Gateway、审计或日志。
21. Token、LLM Key、消息正文和附件秘密不进入日志或错误响应。
22. Workspace 关闭时相关 API 均受功能开关保护。
23. 完成 `pnpm test`、`pnpm lint`、`pnpm build`，并进行 WebSocket、移动端、卡片降级和权限回归验证。

## 18. 当前代码改造边界

实现不能只在 `App.tsx` 增加一个 Bot 设置页。推荐按以下边界拆分：

1. **Protocol**：扩展消息块和事件协议，保留 `plainText` fallback。
2. **Gateway**：独立 Bot Token、WebSocket、事件 ACK、Scope 和连接状态。
3. **Interaction**：卡片注册、命令注册、工作流、幂等、修订号和统一执行管线。
4. **Domain**：用户 Bot、加入群聊、上下文策略、权限和投递记录。
5. **Adapters**：Hermes/OpenClaw SDK 与外部 Adapter，不侵入 Workspace 领域服务。
6. **Frontend**：Bot 管理、Token 轮换、连接状态、卡片渲染和安全提示。

任何一层都不得绕过现有会话成员校验、RBAC、配额、审计、日志脱敏或 `WORKSPACE_ENABLED` 开关。
