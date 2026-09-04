package auth

import (
	"net"
	"net/http"
	"strings"
)

// RequestMeta is the small, non-content audit context accepted by auth
// persistence. It intentionally excludes URL, headers, cookies, bodies, and
// provider responses.
type RequestMeta struct {
	RequestID string
	IPAddress string
	UserAgent string
}

func (meta RequestMeta) Safe() RequestMeta {
	return RequestMeta{
		RequestID: normalizeMetaField(meta.RequestID, 128),
		IPAddress: normalizeIPAddress(meta.IPAddress),
		UserAgent: normalizeMetaField(meta.UserAgent, 512),
	}
}

func RequestMetaFromRequest(request *http.Request, trustProxy ...bool) RequestMeta {
	if request == nil {
		return RequestMeta{}
	}
	ipAddress := remoteIPAddress(request.RemoteAddr)
	if len(trustProxy) > 0 && trustProxy[0] {
		if forwarded := forwardedIPAddress(request.Header.Get("X-Forwarded-For")); forwarded != "" {
			ipAddress = forwarded
		}
	}
	return (RequestMeta{
		RequestID: request.Header.Get("X-Request-ID"),
		IPAddress: ipAddress,
		UserAgent: request.UserAgent(),
	}).Safe()
}

func normalizeMetaField(value string, maxBytes int) string {
	value = strings.TrimSpace(value)
	if len(value) > maxBytes {
		value = value[:maxBytes]
	}
	for _, character := range value {
		if character < 0x20 || character == 0x7f {
			return ""
		}
	}
	return value
}

func normalizeIPAddress(value string) string {
	value = strings.TrimSpace(value)
	if strings.HasPrefix(value, "[") && strings.HasSuffix(value, "]") {
		value = strings.TrimSuffix(strings.TrimPrefix(value, "["), "]")
	}
	if host, _, err := net.SplitHostPort(value); err == nil {
		value = host
	}
	parsed := net.ParseIP(value)
	if parsed == nil {
		return ""
	}
	return parsed.String()
}

func remoteIPAddress(value string) string {
	return normalizeIPAddress(value)
}

func forwardedIPAddress(value string) string {
	for _, candidate := range strings.Split(value, ",") {
		if ip := normalizeIPAddress(candidate); ip != "" {
			return ip
		}
	}
	return ""
}
