package auth

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRequestMetaUsesForwardedClientIPOnlyWhenTrusted(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/api/auth/github/callback", nil)
	request.RemoteAddr = "10.0.0.8:443"
	request.Header.Set("X-Forwarded-For", "198.51.100.7, 10.0.0.9")
	request.Header.Set("X-Request-ID", "req-auth-1")
	request.Header.Set("User-Agent", "workspace-test")

	trusted := RequestMetaFromRequest(request, true)
	if trusted.IPAddress != "198.51.100.7" {
		t.Fatalf("trusted IP = %q, want forwarded client IP", trusted.IPAddress)
	}
	if trusted.RequestID != "req-auth-1" || trusted.UserAgent != "workspace-test" {
		t.Fatalf("trusted metadata = %#v", trusted)
	}

	untrusted := RequestMetaFromRequest(request, false)
	if untrusted.IPAddress != "10.0.0.8" {
		t.Fatalf("untrusted IP = %q, want remote address", untrusted.IPAddress)
	}
}

func TestRequestMetaSkipsInvalidForwardedValuesAndBoundsFields(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	request.RemoteAddr = "[2001:db8::8]:443"
	request.Header.Set("X-Forwarded-For", "unknown, [2001:db8::7]:8443, 198.51.100.9")
	request.Header.Set("X-Request-ID", strings.Repeat("r", 200))
	request.Header.Set("User-Agent", strings.Repeat("u", 700))

	meta := RequestMetaFromRequest(request, true)
	if meta.IPAddress != "2001:db8::7" {
		t.Fatalf("forwarded IPv6 = %q, want first valid address", meta.IPAddress)
	}
	if len(meta.RequestID) != 128 || len(meta.UserAgent) != 512 {
		t.Fatalf("bounded metadata lengths = requestID:%d userAgent:%d", len(meta.RequestID), len(meta.UserAgent))
	}
}
