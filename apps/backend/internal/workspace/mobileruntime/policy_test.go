package mobileruntime

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestNativeRuntimeBoundaryAndRecoveryPaths(t *testing.T) {
	policy := Policy{MinimumSupportedNativeVersionCode: 10054, LatestNativeVersionCode: 10100, APKURL: "/api/v1/mobile/android/latest.apk"}
	for _, code := range []string{"10054", "10055", "10100", "2100000000"} {
		r := httptest.NewRequest(http.MethodGet, "/api/v1/bootstrap", nil)
		r.Header.Set(VersionHeader, code)
		if !Supported(r, policy) {
			t.Errorf("supported native %s rejected", code)
		}
	}
	for _, code := range []string{"", "10051", "10053", "-1", "0", "10054-beta", "010054", " 10054", "2100000001"} {
		r := httptest.NewRequest(http.MethodGet, "/api/v1/bootstrap", nil)
		r.Header.Set(VersionHeader, code)
		if Supported(r, policy) {
			t.Errorf("unsupported native %q accepted", code)
		}
	}
	legacy := httptest.NewRequest(http.MethodGet, "/ws/workspace", nil)
	if !Supported(legacy, policy) {
		t.Fatal("legacy undeclared native background socket must retain staged rollout compatibility")
	}
	conflict := httptest.NewRequest(http.MethodGet, "/ws/workspace?duallaneNativeVersionCode=10055", nil)
	conflict.Header.Set(VersionHeader, "10054")
	if Supported(conflict, policy) {
		t.Fatal("conflicting declarations accepted")
	}
	blankHeader := httptest.NewRequest(http.MethodGet, "/ws/workspace?duallaneNativeVersionCode=10100", nil)
	blankHeader.Header.Set(VersionHeader, "")
	if Supported(blankHeader, policy) {
		t.Fatal("a valid query declaration must not conceal an explicitly empty version header")
	}
	duplicate := httptest.NewRequest(http.MethodGet, "/ws/workspace?duallaneNativeVersionCode=10055&duallaneNativeVersionCode=10055", nil)
	if Supported(duplicate, policy) {
		t.Fatal("duplicate declarations accepted")
	}
	for _, path := range []string{"/api/v1/mobile/releases/latest", "/api/v1/mobile/android/latest.apk", "/api/v1/mobile/android/latest-ota.zip", "/api/auth/mobile/refresh", "/api/auth/mobile/logout", "/api/v1/auth/email/verify", "/api/health", "/ws/p2p", "/api/bot/v2/tasks"} {
		if BusinessPath(path) {
			t.Errorf("recovery/non-native path %s gated", path)
		}
	}
	w := httptest.NewRecorder()
	WriteUpgradeRequired(w, policy)
	if w.Code != 426 || w.Header().Get("Cache-Control") != "no-store" || !strings.Contains(w.Body.String(), `"code":"mobile.native_upgrade_required"`) {
		t.Fatalf("unexpected upgrade response: %d %s", w.Code, w.Body.String())
	}
}

func TestDeclarationBaselineSeparatesFullMigrationFromLegacyCompatibility(t *testing.T) {
	for _, path := range []string{"/api/workspace/messages", "/ws/workspace"} {
		r := httptest.NewRequest(http.MethodGet, path, nil)
		r.Header.Set("Authorization", "Bearer opaque-mobile-session")
		if !Supported(r, Policy{MinimumSupportedNativeVersionCode: 10054}) {
			t.Fatal("legacy phase must retain undeclared old background transport")
		}
		if Supported(r, Policy{MinimumSupportedNativeVersionCode: FirstNativeDeclarationVersionCode}) {
			t.Fatal("full migration accepted missing native declaration")
		}
		r.Header.Del("Authorization")
		r.AddCookie(&http.Cookie{Name: "workspace_session", Value: "opaque-web-session"})
		if !Supported(r, Policy{MinimumSupportedNativeVersionCode: FirstNativeDeclarationVersionCode}) {
			t.Fatal("cookie Web client was treated as an obsolete native host")
		}
	}
}
