// Package sdkgate owns the transport compatibility declaration required by
// Agent Bot clients. The declaration is deliberately separate from Bot
// authentication and task authorization: it only handles a compatible SDK
// transport declaration. Authentication and authorization remain separate
// checks.
package sdkgate

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
)

const (
	// MinimumSDKVersion follows the published release: older SDKs must upgrade
	// before using Bot credentials, setup or Agent transports.
	MinimumSDKVersion = LatestSDKVersion
	// LatestSDKVersion is the newest published contract advertised by this
	// server. Stable 1.x clients newer than this value are accepted when they
	// remain backward compatible with the minimum contract.
	LatestSDKVersion = "1.2.2"

	SDKVersionHeader = "X-DualLane-SDK-Version"

	// WebSocketProtocolPrefix is an HTTP token prefix. Browser WebSocket APIs
	// cannot set arbitrary request headers, so they declare the same version in
	// Sec-WebSocket-Protocol instead.
	WebSocketProtocolPrefix = "duallane-agent-sdk-"

	RuntimeManifestURL = "/integrations/duallane-agent.manifest.json"
	DocsURL            = "/integrations/v2/duallane-channel.md"
	SkillURL           = "/integrations/duallane-agent/SKILL.md"

	UpgradeRequiredCode = "sdk.upgrade_required"
)

// UpgradeRequiredError is the only public error produced by the SDK gate.
// It intentionally does not retain or expose the supplied version: version
// compatibility is not an authentication mechanism and must not become a
// credential or deployment fingerprint oracle.
type UpgradeRequiredError struct{}

func (UpgradeRequiredError) Error() string { return UpgradeRequiredCode }

// Public returns the stable content-free error object used by HTTP transports.
func (UpgradeRequiredError) Public() map[string]any {
	return map[string]any{
		"code":               UpgradeRequiredCode,
		"message":            "Agent SDK upgrade required",
		"minimumSdkVersion":  MinimumSDKVersion,
		"latestSdkVersion":   LatestSDKVersion,
		"runtimeManifestUrl": RuntimeManifestURL,
		"docsUrl":            DocsURL,
		"skillUrl":           SkillURL,
	}
}

// WriteUpgradeRequired projects the same content-free response for transports
// that cannot pass through the normal application error writer (notably a
// WebSocket handshake before the HTTP upgrade is accepted).
func WriteUpgradeRequired(response http.ResponseWriter) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(http.StatusUpgradeRequired)
	_ = json.NewEncoder(response).Encode(map[string]any{"error": UpgradeRequiredError{}.Public()})
}

// RequireHTTP validates the SDK declaration on a credentialed Bot HTTP
// request. Callers should authenticate the Bot first so an unauthenticated
// request retains the existing 401 boundary.
func RequireHTTP(request *http.Request) error {
	if request == nil {
		return UpgradeRequiredError{}
	}
	values := request.Header.Values(SDKVersionHeader)
	if len(values) != 1 {
		return UpgradeRequiredError{}
	}
	return ValidateVersion(values[0])
}

// WebSocketProtocol returns the browser-compatible subprotocol token for a
// version that has already passed ValidateVersion.
func WebSocketProtocol(version string) string {
	return WebSocketProtocolPrefix + strings.TrimSpace(version)
}

// RequireWebSocket validates the header declaration and, when present, the
// browser-compatible Sec-WebSocket-Protocol declaration. The returned token
// is the only protocol the server should echo during websocket.Accept.
func RequireWebSocket(request *http.Request) (string, error) {
	if request == nil {
		return "", UpgradeRequiredError{}
	}
	headerValues := request.Header.Values(SDKVersionHeader)
	if len(headerValues) > 1 {
		return "", UpgradeRequiredError{}
	}
	headerVersion := ""
	if len(headerValues) == 1 {
		headerVersion = strings.TrimSpace(headerValues[0])
	}
	protocolVersion, protocolToken, protocolPresent := websocketVersion(request.Header.Values("Sec-WebSocket-Protocol"))

	if headerVersion == "" && !protocolPresent {
		return "", UpgradeRequiredError{}
	}
	if headerVersion != "" {
		if err := ValidateVersion(headerVersion); err != nil {
			return "", err
		}
		if protocolPresent {
			if err := ValidateVersion(protocolVersion); err != nil {
				return "", err
			}
			if protocolVersion != headerVersion {
				return "", UpgradeRequiredError{}
			}
		}
		return protocolToken, nil
	}
	if err := ValidateVersion(protocolVersion); err != nil {
		return "", err
	}
	return protocolToken, nil
}

func websocketVersion(values []string) (version, token string, present bool) {
	for _, value := range values {
		for _, candidate := range strings.Split(value, ",") {
			candidate = strings.TrimSpace(candidate)
			if !strings.HasPrefix(candidate, WebSocketProtocolPrefix) {
				continue
			}
			present = true
			if token != "" {
				// Multiple SDK declarations are ambiguous. Keep the first value;
				// RequireWebSocket will reject it through the mismatch check below.
				return "", token, true
			}
			token = candidate
			version = strings.TrimPrefix(candidate, WebSocketProtocolPrefix)
		}
	}
	return version, token, present
}

// ValidateVersion accepts stable semantic versions in the supported major
// line. Future 1.x patch/minor clients are compatible by contract; major 0 or
// 2+ clients must not use a 1.x server transport.
func ValidateVersion(raw string) error {
	major, minor, patch, ok := parseVersion(raw)
	minimumMajor, minimumMinor, minimumPatch, minimumOK := parseVersion(MinimumSDKVersion)
	if !ok || !minimumOK || major != minimumMajor || minor < minimumMinor || (minor == minimumMinor && patch < minimumPatch) {
		return UpgradeRequiredError{}
	}
	return nil
}

func parseVersion(raw string) (major, minor, patch int, ok bool) {
	parts := strings.Split(strings.TrimSpace(raw), ".")
	if len(parts) != 3 {
		return 0, 0, 0, false
	}
	values := []*int{&major, &minor, &patch}
	for i, part := range parts {
		if part == "" || (len(part) > 1 && part[0] == '0') {
			return 0, 0, 0, false
		}
		for _, character := range part {
			if character < '0' || character > '9' {
				return 0, 0, 0, false
			}
		}
		value, err := strconv.Atoi(part)
		if err != nil || value < 0 {
			return 0, 0, 0, false
		}
		*values[i] = value
	}
	return major, minor, patch, true
}
