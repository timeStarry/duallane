export const DAILY_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;

export function remainingQuota(usedToday, limit = DAILY_QUOTA_BYTES) {
  return Math.max(0, limit - usedToday);
}

export function canReserveQuota(usedToday, targetSize, limit = DAILY_QUOTA_BYTES) {
  if (!Number.isSafeInteger(targetSize) || targetSize < 0) {
    return false;
  }
  return targetSize <= remainingQuota(usedToday, limit);
}
