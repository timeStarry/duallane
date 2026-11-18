import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MobileNativeRequirements } from "./MobileNativeRequirements";

describe("mobile release compatibility controls", () => {
  it("shows distinct compatible and mandatory minimums and explains the zero recovery value", () => {
    const markup = renderToStaticMarkup(<MobileNativeRequirements otaFloor={10051} supportedFloor={10054} apkCode={10100} disabled={false} otaAvailable onOtaFloorChange={() => {}} onSupportedFloorChange={() => {}} />);
    expect(markup).toContain('for="mobile-ota-native-floor"');
    expect(markup).toContain('for="mobile-supported-native-floor"');
    expect(markup).toContain('value="10051"');
    expect(markup).toContain('value="10054"');
    expect(markup).toContain("填 0 关闭强制更新");
  });
});
