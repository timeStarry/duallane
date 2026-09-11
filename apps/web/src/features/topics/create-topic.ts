import { createWorkspaceJsonHeaders } from "../../workspace-http";
import type { WorkspaceTopic } from "../../WorkspaceTopics";

export type TopicCreateFields = { conversationId: string; title: string; description: string; allowSyncToGroup: boolean };

export function validateTopicCreate(fields: TopicCreateFields): string | null {
  if (!fields.conversationId) return "请选择所属群聊。";
  const title = fields.title.trim();
  if (!title || [...title].length > 40 || /[\[\]\r\n]/u.test(title)) return "标题须为 1–40 个字符，不能含方括号或换行。";
  const description = fields.description.trim();
  if (!description) return "请填写话题正文。";
  if ([...description].length > 30_000 || new TextEncoder().encode(description).byteLength > 100 * 1024) return "正文最多 30,000 个字符，且不超过 100 KiB。";
  return null;
}

export function topicCreatePayload(fields: TopicCreateFields, idempotencyKey: string) {
  // Send separate JSON fields. Parentheses, Markdown and topic syntax in the
  // description stay content; they are never concatenated into a command.
  return { title: fields.title.trim(), description: fields.description.trim(), allowSyncToGroup: fields.allowSyncToGroup, idempotencyKey };
}

export async function createTopic(fields: TopicCreateFields, idempotencyKey: string): Promise<WorkspaceTopic> {
  const validation = validateTopicCreate(fields);
  if (validation) throw new Error(validation);
  const body = JSON.stringify(topicCreatePayload(fields, idempotencyKey));
  const response = await fetch(`/api/workspace/conversations/${encodeURIComponent(fields.conversationId)}/topics`, {
    method: "POST",
    headers: createWorkspaceJsonHeaders({ body }),
    body
  });
  const result = await response.json() as { topic?: WorkspaceTopic; error?: { message?: string } };
  if (!response.ok || !result.topic) throw new Error(result.error?.message || "创建话题失败，请保留当前输入后重试。");
  return result.topic;
}
