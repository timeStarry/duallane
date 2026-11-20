package sdkgate

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestValidateVersionCompatibilityBoundary(t *testing.T) {
	for _, version := range []string{LatestSDKVersion, "1.3.0", "1.99.0"} {
		if err := ValidateVersion(version); err != nil {
			t.Errorf("ValidateVersion(%q) = %v, want accepted", version, err)
		}
	}
	for _, version := range []string{"", "1", "1.1.99", "1.2.0", "1.2.1", "0.9.0", "2.0.0", "v1.2.0", "1.2.0-beta", "01.2.0", "1.02.0", "1.2"} {
		if err := ValidateVersion(version); err == nil {
			t.Errorf("ValidateVersion(%q) accepted unsupported version", version)
		}
	}
}

func TestRequireHTTPUsesStablePublicUpgradeDetails(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/api/bot-gateway/v1/me", nil)
	err := RequireHTTP(request)
	upgrade, ok := err.(UpgradeRequiredError)
	if !ok {
		t.Fatalf("RequireHTTP() error = %T %v, want UpgradeRequiredError", err, err)
	}
	public := upgrade.Public()
	for key, want := range map[string]any{
		"code": UpgradeRequiredCode, "minimumSdkVersion": MinimumSDKVersion,
		"latestSdkVersion": LatestSDKVersion, "runtimeManifestUrl": RuntimeManifestURL,
		"docsUrl": DocsURL, "skillUrl": SkillURL,
	} {
		if public[key] != want {
			t.Errorf("public[%q] = %#v, want %#v", key, public[key], want)
		}
	}
}

func TestRequireWebSocketSupportsHeaderAndBrowserSubprotocol(t *testing.T) {
	withHeader := httptest.NewRequest(http.MethodGet, "/ws/bot-gateway", nil)
	withHeader.Header.Set(SDKVersionHeader, MinimumSDKVersion)
	if token, err := RequireWebSocket(withHeader); err != nil || token != "" {
		t.Fatalf("header declaration = (%q, %v), want no selected protocol", token, err)
	}

	withProtocol := httptest.NewRequest(http.MethodGet, "/ws/bot-gateway", nil)
	withProtocol.Header.Set("Sec-WebSocket-Protocol", WebSocketProtocol(MinimumSDKVersion))
	if token, err := RequireWebSocket(withProtocol); err != nil || token != WebSocketProtocol(MinimumSDKVersion) {
		t.Fatalf("browser declaration = (%q, %v), want protocol token", token, err)
	}

	conflicting := httptest.NewRequest(http.MethodGet, "/ws/bot-gateway", nil)
	conflicting.Header.Set(SDKVersionHeader, MinimumSDKVersion)
	conflicting.Header.Set("Sec-WebSocket-Protocol", WebSocketProtocol("1.1.0"))
	if _, err := RequireWebSocket(conflicting); err == nil {
		t.Fatal("conflicting header and subprotocol declarations were accepted")
	}
}
