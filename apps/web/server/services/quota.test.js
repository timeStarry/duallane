import { describe, expect, it } from "vitest";
import { DAILY_QUOTA_BYTES, canReserveQuota, remainingQuota } from "./quota.mjs";

describe("quota service", () => {
  it("computes remaining daily bytes", () => {
    expect(remainingQuota(1024, 4096)).toBe(3072);
  });

  it("rejects reservations beyond the remaining quota", () => {
    expect(canReserveQuota(DAILY_QUOTA_BYTES - 10, 11)).toBe(false);
    expect(canReserveQuota(DAILY_QUOTA_BYTES - 10, 10)).toBe(true);
  });

  it("rejects invalid file sizes", () => {
    expect(canReserveQuota(0, -1)).toBe(false);
    expect(canReserveQuota(0, Number.MAX_SAFE_INTEGER + 1)).toBe(false);
  });
});
