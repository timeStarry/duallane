const DAY_IN_MS = 24 * 60 * 60 * 1000;

function localDayNumber(date: Date) {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_IN_MS;
}

export function formatWorkspaceConversationTime(value: string, now = new Date()) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const dayDelta = localDayNumber(now) - localDayNumber(date);
  if (dayDelta === 0) {
    return new Intl.DateTimeFormat("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).format(date);
  }
  if (dayDelta === 1) {
    return "昨天";
  }
  if (dayDelta === 2) {
    return "前天";
  }
  if (date.getFullYear() === now.getFullYear()) {
    return `${date.getMonth() + 1}月${date.getDate()}日`;
  }
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}
