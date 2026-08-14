import { describe, expect, it } from "vitest";
import {
  BOT_GROUP_POLICY_OPTIONS,
  buildBotGroupPolicyPatch,
  parseBotMemberIds,
  resolveBotGroupPolicyMode
} from "./WorkspaceBotSettings";

describe("WorkspaceBotSettings policy helpers", () => {
  it("maps the three group modes to the gateway settings projection", () => {
    expect(buildBotGroupPolicyPatch("direct_only")).toEqual({ allowGroup: false, requireOwnerApproval: true });
    expect(buildBotGroupPolicyPatch("allow_group")).toEqual({ allowGroup: true, requireOwnerApproval: false });
    expect(buildBotGroupPolicyPatch("approval_required")).toEqual({ allowGroup: true, requireOwnerApproval: true });
  });

  it("resolves a mode from persisted settings without relying on bot internals", () => {
    expect(resolveBotGroupPolicyMode({ allowGroup: false, requireOwnerApproval: false })).toBe("direct_only");
    expect(resolveBotGroupPolicyMode({ allowGroup: true, requireOwnerApproval: false })).toBe("allow_group");
    expect(resolveBotGroupPolicyMode({ allowGroup: true, requireOwnerApproval: true })).toBe("approval_required");
  });

  it("normalizes member id input and removes duplicate separators", () => {
    expect(parseBotMemberIds("usr_a, usr_b\nusr_a，usr_c、usr_b")).toEqual(["usr_a", "usr_b", "usr_c"]);
    expect(parseBotMemberIds("  ")).toEqual([]);
  });

  it("keeps the visible policy choices stable for the settings UI", () => {
    expect(BOT_GROUP_POLICY_OPTIONS.map((option) => option.value)).toEqual([
      "direct_only",
      "allow_group",
      "approval_required"
    ]);
  });
});

