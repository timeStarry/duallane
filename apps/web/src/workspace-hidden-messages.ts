export type WorkspaceMessageDisplayItem<T> =
  | { kind: "message"; message: T; sourceIndex: number }
  | { kind: "hidden"; messages: T[]; sourceIndex: number };

export function groupHiddenWorkspaceMessages<T extends { hiddenByCurrentUser?: boolean }>(messages: T[]) {
  const items: WorkspaceMessageDisplayItem<T>[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message.hiddenByCurrentUser) {
      items.push({ kind: "message", message, sourceIndex: index });
      continue;
    }
    const hidden: T[] = [message];
    while (index + 1 < messages.length && messages[index + 1].hiddenByCurrentUser) {
      hidden.push(messages[index + 1]);
      index += 1;
    }
    items.push({ kind: "hidden", messages: hidden, sourceIndex: index - hidden.length + 1 });
  }
  return items;
}
