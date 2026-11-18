// Package mobileruntime owns the public native-runtime compatibility gate.
// Version declarations never identify an actor or grant object access.
package mobileruntime

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
)

const VersionHeader = "X-DualLane-Native-Version-Code"
const WebSocketVersionQuery = "duallaneNativeVersionCode"
const UpgradeRequiredCode = "mobile.native_upgrade_required"

// FirstNativeDeclarationVersionCode is the first released APK line whose
// native HTTP, binary transfers and background Workspace WS always declare
// their packaged code. Raising the supported floor to this line completes
// migration and permits rejecting undeclared mobile sessions as well.
const FirstNativeDeclarationVersionCode = 10100

type Policy struct {
	MinimumSupportedNativeVersionCode int    `json:"minimumSupportedNativeVersionCode"`
	LatestNativeVersionCode           int    `json:"latestNativeVersionCode"`
	APKURL                            string `json:"apkUrl"`
}

// BusinessPath excludes recovery, authentication and public distribution so a
// rejected client can always download and install a compatible APK.
func BusinessPath(path string) bool {
	return strings.HasPrefix(path, "/api/workspace/") ||
		(strings.HasPrefix(path, "/api/v1/") && !strings.HasPrefix(path, "/api/v1/auth/") && !strings.HasPrefix(path, "/api/v1/mobile/")) ||
		path == "/ws/workspace"
}

func Declared(request *http.Request) bool {
	return len(request.Header.Values(VersionHeader)) > 0 ||
		(request.URL.Path == "/ws/workspace" && request.URL.Query().Has(WebSocketVersionQuery))
}

// UsesBearerTransport selects a possible native session only. The caller must
// still authenticate it as a human mobile actor before applying this policy.
// Bot SDK routes are outside BusinessPath and use their own authentication.
func UsesBearerTransport(request *http.Request) bool {
	parts := strings.Fields(request.Header.Get("Authorization"))
	return len(parts) > 0 && strings.EqualFold(parts[0], "Bearer")
}

// Supported retains undeclared native sessions only while the supported floor
// is below the declaration-capable native baseline. At/above that baseline a
// missing declaration cannot satisfy the policy. Cookie-based Web sessions do
// not become native sessions merely because a floor is configured.
func Supported(request *http.Request, policy Policy) bool {
	if policy.MinimumSupportedNativeVersionCode <= 0 {
		return true
	}
	if !Declared(request) {
		return policy.MinimumSupportedNativeVersionCode < FirstNativeDeclarationVersionCode || !UsesBearerTransport(request)
	}
	values := request.Header.Values(VersionHeader)
	query := []string(nil)
	if request.URL.Path == "/ws/workspace" {
		query = request.URL.Query()[WebSocketVersionQuery]
	}
	if len(values) > 1 || len(query) > 1 {
		return false
	}
	version := ""
	if len(values) == 1 {
		version = values[0]
		if version == "" {
			return false
		}
	}
	if len(query) == 1 {
		if version != "" && version != query[0] {
			return false
		}
		version = query[0]
	}
	if version == "" || len(version) > 10 || strings.TrimSpace(version) != version || (len(version) > 1 && version[0] == '0') {
		return false
	}
	for _, ch := range version {
		if ch < '0' || ch > '9' {
			return false
		}
	}
	code, err := strconv.Atoi(version)
	return err == nil && code >= policy.MinimumSupportedNativeVersionCode && code <= 2100000000
}

func WriteUpgradeRequired(w http.ResponseWriter, policy Policy) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusUpgradeRequired)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]any{
		"code": UpgradeRequiredCode, "message": "请安装新版 DualLane 后继续使用",
		"minimumSupportedNativeVersionCode": policy.MinimumSupportedNativeVersionCode,
		"latestNativeVersionCode":           policy.LatestNativeVersionCode,
		"apkUrl":                            policy.APKURL, "releaseUrl": "/api/v1/mobile/releases/latest",
	}})
}
