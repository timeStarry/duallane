package auth

import (
	"net/url"
	"strings"
)

// NormalizeReturnTarget accepts only same-origin Workspace paths. It is used
// for the OAuth return cookie and therefore rejects fragments, encoded path
// escapes, and every absolute/open-redirect form.
func NormalizeReturnTarget(value string) string {
	candidate := strings.TrimSpace(value)
	if candidate == "" || !strings.HasPrefix(candidate, "/") || strings.HasPrefix(candidate, "//") || strings.Contains(candidate, `\`) || strings.Contains(candidate, "#") || containsControl(candidate) {
		return ""
	}

	base, err := url.Parse("https://duallane.invalid")
	if err != nil {
		return ""
	}
	parsed, err := base.Parse(candidate)
	if err != nil || parsed.Scheme != base.Scheme || parsed.Host != base.Host || parsed.User != nil {
		return ""
	}
	decodedPath, err := url.PathUnescape(parsed.EscapedPath())
	if err != nil || strings.Contains(decodedPath, `\`) || containsControl(decodedPath) {
		return ""
	}
	if parsed.Path != "/workspace" && !strings.HasPrefix(parsed.Path, "/workspace/") {
		return ""
	}
	return parsed.EscapedPath() + queryString(parsed)
}

func queryString(value *url.URL) string {
	if value == nil || value.RawQuery == "" {
		return ""
	}
	return "?" + value.RawQuery
}

func containsControl(value string) bool {
	for _, character := range value {
		if character < 0x20 || character == 0x7f {
			return true
		}
	}
	return false
}
