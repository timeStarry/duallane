import type { V1Conversation, V1Message, V1User } from "./store";
import type { ThreadViewResponse } from "@/shared/lib/api-v1";

export function buildDevPreviewFixture() {
  const currentUser: V1User = {
    id: "usr_owner_1",
    displayName: "林知远",
    handle: "zhiyuan",
    role: "owner",
  };

  const members: Record<string, V1User> = {
    usr_owner_1: currentUser,
    usr_sumu: { id: "usr_sumu", displayName: "苏沐", handle: "sumu", role: "admin" },
    usr_chenche: { id: "usr_chenche", displayName: "陈彻", handle: "chenche", role: "member" },
    usr_bot_echo: { id: "usr_bot_echo", displayName: "Echo 智能体", handle: "echo", role: "bot" },
  };

  const conversations: Record<string, V1Conversation> = {
    conv_saved: {
      id: "conv_saved",
      kind: "saved",
      title: "我的收藏",
      unreadCount: 0,
      mentionCount: 0,
      pinnedMessageIds: [],
      memberIds: ["usr_owner_1"],
      lastMessageText: "v1.0 核心令牌：--dl-glass-chrome / --dl-glass-elevated",
      lastMessageAt: "2026-11-14T01:40:00Z",
    },
    conv_arch: {
      id: "conv_arch",
      kind: "group",
      title: "v1.0 视觉与架构攻坚",
      unreadCount: 0,
      mentionCount: 0,
      pinnedMessageIds: ["msg_arch_1", "msg_arch_card"],
      memberIds: ["usr_owner_1", "usr_sumu", "usr_chenche", "usr_bot_echo"],
      lastMessageText: "已生成部署审批卡片，请各位确认签收。",
      lastMessageAt: "2026-11-14T02:05:00Z",
      lastMessageSenderId: "usr_bot_echo",
      lastMessageSenderName: "Echo 智能体",
    },
    conv_sumu: {
      id: "conv_sumu",
      kind: "direct",
      title: "苏沐",
      unreadCount: 2,
      mentionCount: 0,
      pinnedMessageIds: [],
      memberIds: ["usr_owner_1", "usr_sumu"],
      lastMessageText: "深色模式下的气泡文字对比度我核对过了，现在非常通透。",
      lastMessageAt: "2026-11-14T01:58:00Z",
      lastMessageSenderId: "usr_sumu",
      lastMessageSenderName: "苏沐",
    },
    conv_mobile: {
      id: "conv_mobile",
      kind: "group",
      title: "Mobile v1.0 同步专项",
      unreadCount: 5,
      mentionCount: 1,
      pinnedMessageIds: [],
      memberIds: ["usr_owner_1", "usr_chenche"],
      lastMessageText: "@林知远 /api/v1/sync 增量游标和扫码登录已联调就绪",
      lastMessageAt: "2026-11-14T01:52:00Z",
      lastMessageSenderId: "usr_chenche",
      lastMessageSenderName: "陈彻",
    },
  };

  const conversationOrder = ["conv_saved", "conv_arch", "conv_sumu", "conv_mobile"];

  const messagesByConv: Record<string, V1Message[]> = {
    conv_saved: [
      {
        id: "msg_saved_1",
        conversationId: "conv_saved",
        senderId: "usr_owner_1",
        senderName: "林知远",
        plainText: "v1.0 核心令牌：--dl-glass-chrome / --dl-glass-elevated，全端共享 @duallane/design-tokens。",
        createdAt: "2026-11-14T01:40:00Z",
        status: "read",
        reactions: { "🔥": { count: 1, reactedByMe: true } },
      },
    ],
    conv_arch: [
      {
        id: "msg_arch_1",
        conversationId: "conv_arch",
        senderId: "usr_sumu",
        senderName: "苏沐",
        plainText:
          "视觉层级定稿：左轨固定 68px 承载双通道保活切换，会话列表 288px，主时间流自适应，右侧 Inspector 非模态展开线程与文件定位。",
        threadReplyCount: 3,
        createdAt: "2026-11-14T01:50:00Z",
        status: "read",
        reactions: {
          "👍": { count: 3, reactedByMe: true },
          "🎉": { count: 2, reactedByMe: false },
        },
      },
      {
        id: "msg_arch_2",
        conversationId: "conv_arch",
        senderId: "usr_sumu",
        senderName: "苏沐",
        plainText: "连续同人消息自动收起重复头像与昵称，气泡圆角随上下文贴合，悬停操作条改为右上浮层胶囊，不再撑开消息行距。",
        createdAt: "2026-11-14T01:51:00Z",
        status: "read",
        reactions: {},
      },
      {
        id: "msg_arch_3",
        conversationId: "conv_arch",
        senderId: "usr_owner_1",
        senderName: "林知远",
        plainText: "收到，P2P 直连与共享空间已经支持 ⌘1 / ⌘2 零重载瞬切，草稿和滚动位置独立记忆。",
        replyToId: "msg_arch_1",
        editedAt: "2026-11-14T01:56:00Z",
        createdAt: "2026-11-14T01:55:00Z",
        status: "read",
        reactions: { "❤️": { count: 2, reactedByMe: false } },
        attachments: [
          {
            id: "att_spec_1",
            fileName: "DualLane-v1-Vibrancy-Spec.pdf",
            mimeType: "application/pdf",
            byteSize: 428190,
            url: "#",
            sourceMessageId: "msg_arch_3",
          },
        ],
      },
      {
        id: "msg_arch_card",
        conversationId: "conv_arch",
        senderId: "usr_bot_echo",
        senderName: "Echo 智能体",
        plainText: "v1.0 发布签收与体验投票",
        createdAt: "2026-11-14T02:05:00Z",
        status: "read",
        reactions: {},
        card: {
          version: 1,
          cardId: "card_v1_signoff",
          cardType: "release.signoff",
          status: "active",
          revision: 1,
          fallbackText: "DualLane v1.0 架构与视觉验收",
          blocks: [
            {
              type: "header",
              title: "DualLane v1.0 架构与视觉签收",
              subtitle: "Vibrancy Glass · Thread-First · Bot Platform 2.0",
              badge: "待签收",
              tone: "shared",
            },
            {
              type: "markdown",
              content: "已完成 Tailwind v4 语义令牌、双通道保活切换、右侧非模态线程面板与 Card Kit v1 交互卡片重构。",
            },
            {
              type: "fields",
              items: [
                { label: "设计语言", value: "macOS / iOS Vibrancy", short: true },
                { label: "动效引擎", value: "Motion Spring Physics", short: true },
                { label: "移动端同步", value: "/api/v1/sync + 扫码登录", short: true },
                { label: "P2P 安全红线", value: "#k= 仅驻留内存", short: true },
              ],
            },
            {
              type: "poll",
              pollId: "poll_v1_ux",
              totalVotes: 8,
              options: [
                { id: "opt_1", label: "飞书般自洽的信息层级 + Telegram 般丝滑交互", votes: 6, selected: true },
                { id: "opt_2", label: "继续微调细节参数", votes: 2 },
              ],
            },
            { type: "divider" },
            {
              type: "actions",
              elements: [
                {
                  type: "button",
                  actionId: "open_feedback_modal",
                  label: "填写验收备注",
                  style: "primary",
                  opensModal: true,
                  payload: {
                    modal: {
                      modalId: "signoff_note",
                      title: "提交 v1.0 验收备注",
                      submitLabel: "确认提交",
                      fields: [
                        { name: "reviewer", label: "验收人", kind: "text", placeholder: "输入姓名", required: true },
                        {
                          name: "verdict",
                          label: "验收结论",
                          kind: "select",
                          defaultValue: "pass",
                          options: [
                            { value: "pass", label: "通过验收，准予合入" },
                            { value: "polish", label: "建议补充细节打磨" },
                          ],
                        },
                        { name: "syncMobile", label: "同步启动 Mobile v1.0 构建", kind: "switch", defaultValue: true },
                      ],
                    },
                  },
                },
                { type: "button", actionId: "approve_direct", label: "一键通过", style: "default" },
              ],
            },
          ],
        },
      },
    ],
    conv_sumu: [
      {
        id: "msg_sumu_1",
        conversationId: "conv_sumu",
        senderId: "usr_sumu",
        senderName: "苏沐",
        plainText: "深色模式下的气泡文字对比度我核对过了，现在非常通透。",
        createdAt: "2026-11-14T01:58:00Z",
        status: "read",
        reactions: {},
      },
    ],
    conv_mobile: [
      {
        id: "msg_mob_1",
        conversationId: "conv_mobile",
        senderId: "usr_chenche",
        senderName: "陈彻",
        plainText: "@林知远 /api/v1/sync 增量游标和扫码登录已联调就绪",
        createdAt: "2026-11-14T01:52:00Z",
        status: "read",
        reactions: {},
      },
    ],
  };

  const threadsByRootId: Record<string, ThreadViewResponse> = {
    msg_arch_1: {
      rootMessageId: "msg_arch_1",
      threadTitle: "四栏信息架构与响应式折叠细节",
      replyCount: 3,
      replies: [
        {
          id: "msg_tr_1",
          conversationId: "conv_arch",
          threadRootId: "msg_arch_1",
          alsoSendToChannel: false,
          authorId: "usr_chenche",
          authorName: "陈彻",
          plainText: "后端 thread_root_id 已经和旧版 topics 收敛到同一张 messages 表，查询延迟 < 2ms。",
          createdAt: "2026-11-14T01:52:00Z",
        },
        {
          id: "msg_tr_2",
          conversationId: "conv_arch",
          threadRootId: "msg_arch_1",
          alsoSendToChannel: false,
          authorId: "usr_sumu",
          authorName: "苏沐",
          plainText: "窄屏（< 1100px）下右侧 Inspector 自动切换为毛玻璃浮层抽屉，不会挤压主时间流宽度。",
          createdAt: "2026-11-14T01:53:00Z",
        },
        {
          id: "msg_tr_3",
          conversationId: "conv_arch",
          threadRootId: "msg_arch_1",
          alsoSendToChannel: true,
          authorId: "usr_owner_1",
          authorName: "林知远",
          plainText: "非常自洽，保留「同时发送到主对话」开关即可兼顾轻量讨论和重要结论广播。",
          createdAt: "2026-11-14T01:54:00Z",
        },
      ],
    },
  };

  return {
    currentUser,
    quotaUsedBytes: 142 * 1024 * 1024,
    quotaLimitBytes: 512 * 1024 * 1024,
    members,
    conversations,
    conversationOrder,
    messagesByConv,
    activeConversationId: "conv_arch",
    threadsByRootId,
    drafts: {
      conv_sumu: { text: "下午对齐一下移动端扫码页的毛玻璃圆角参数" },
    },
  };
}
