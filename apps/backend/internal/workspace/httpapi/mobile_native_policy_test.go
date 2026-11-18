package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/gate"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/mobileruntime"
)

func TestNativeUpgradeRejectsBeforeBusinessButAfterAuthentication(t *testing.T) {
	policy := func(context.Context) (mobileruntime.Policy, error) {
		return mobileruntime.Policy{MinimumSupportedNativeVersionCode: 10054, LatestNativeVersionCode: 10100, APKURL: "/api/v1/mobile/android/latest.apk"}, nil
	}
	service := &fakeInvites{}
	resolver := &fakeResolver{actor: &auth.Actor{ID: "owner", Kind: "human", Role: "owner"}}
	router := NewRouter(RouterOptions{Gate: gate.New("true"), ActorResolver: resolver, Invites: service, MobileNativePolicy: policy})
	r := httptest.NewRequest(http.MethodPost, "/api/workspace/invites", strings.NewReader(`{"code":"must-not-reach-business"}`))
	r.Header.Set(mobileruntime.VersionHeader, "10051")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, r)
	if w.Code != 426 || service.calls != 0 || resolver.calls != 1 {
		t.Fatalf("native gate boundary: status=%d service=%d auth=%d", w.Code, service.calls, resolver.calls)
	}
	resolver.actor = nil
	w = httptest.NewRecorder()
	router.ServeHTTP(w, r)
	if w.Code != 401 || service.calls != 0 {
		t.Fatalf("authentication lost precedence: %d", w.Code)
	}
}

func TestFullNativeMigrationRequiresDeclarationsOnlyForAuthenticatedMobileHumans(t *testing.T) {
	for _, tc := range []struct {
		name, path, bearer, native, kind string
		authenticated                    bool
		want                             int
	}{
		{"human bearer missing code", "/api/workspace/messages", "opaque-mobile-session", "", "human", true, 426},
		{"human websocket missing code", "/ws/workspace", "opaque-mobile-session", "", "human", true, 426},
		{"cookie Web session", "/api/workspace/messages", "", "", "human", true, 204},
		{"old declared host", "/api/workspace/messages", "opaque-mobile-session", "10055", "human", true, 426},
		{"new declared host", "/api/workspace/messages", "opaque-mobile-session", "10100", "human", true, 204},
		{"new declared websocket", "/ws/workspace", "opaque-mobile-session", "10100", "human", true, 204},
		{"invalid declaration", "/api/workspace/messages", "opaque-mobile-session", "unknown", "human", true, 426},
		{"unauthenticated bearer", "/api/workspace/messages", "invalid-session", "", "human", false, 401},
		{"unauthenticated declared bearer", "/api/workspace/messages", "invalid-session", "10055", "human", false, 401},
		{"public APK recovery", "/api/v1/mobile/android/latest.apk", "opaque-mobile-session", "", "human", true, 204},
		{"public metadata recovery", "/api/v1/mobile/releases/latest", "opaque-mobile-session", "", "human", true, 204},
		{"session recovery", "/api/auth/mobile/refresh", "opaque-mobile-session", "", "human", true, 204},
		{"logout recovery", "/api/auth/mobile/logout", "opaque-mobile-session", "", "human", true, 204},
		{"Bot SDK separate lane", "/api/bot/v2/tasks", "dl_bot_opaque", "", "bot", true, 204},
		{"authenticated nonhuman is not inferred native", "/api/workspace/messages", "dl_bot_opaque", "", "bot", true, 204},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resolver := &fakeResolver{}
			if tc.authenticated {
				resolver.actor = &auth.Actor{ID: "actor", Kind: tc.kind, Role: "member"}
			}
			policyCalls, businessCalls := 0, 0
			handler := nativeRuntimeMiddleware(RouterOptions{Gate: gate.New("true"), ActorResolver: resolver, MobileNativePolicy: func(context.Context) (mobileruntime.Policy, error) {
				policyCalls++
				return mobileruntime.Policy{MinimumSupportedNativeVersionCode: mobileruntime.FirstNativeDeclarationVersionCode, LatestNativeVersionCode: 10100, APKURL: "/api/v1/mobile/android/latest.apk"}, nil
			}}, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { businessCalls++; w.WriteHeader(http.StatusNoContent) }))
			r := httptest.NewRequest(http.MethodGet, tc.path, nil)
			if tc.bearer != "" {
				r.Header.Set("Authorization", "Bearer "+tc.bearer)
			} else {
				r.AddCookie(&http.Cookie{Name: "workspace_session", Value: "opaque-web-session"})
			}
			if tc.native != "" {
				r.Header.Set(mobileruntime.VersionHeader, tc.native)
			}
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			if w.Code != tc.want {
				t.Fatalf("status=%d want=%d body=%s", w.Code, tc.want, w.Body.String())
			}
			if tc.want != 204 && businessCalls != 0 {
				t.Fatal("rejected request reached business work")
			}
			if tc.want == 401 && policyCalls != 0 {
				t.Fatal("version policy read before authentication")
			}
		})
	}
}
