package metrics

import (
	"errors"
	"strings"
	"unicode"
)

const (
	// ServiceWorkspace identifies the Workspace API and its durable workers.
	ServiceWorkspace Service = "workspace"
	// ServiceWorker identifies the standalone Workspace worker process.
	ServiceWorker Service = "worker"
	// ServiceOther is the fixed bucket for an unrecognized service name.
	ServiceOther Service = "other"
)

// Service is a bounded service label used by the private metrics registry.
type Service string

func normalizeService(value Service) string {
	switch value {
	case ServiceWorkspace, ServiceWorker:
		return string(value)
	default:
		return string(ServiceOther)
	}
}

func normalizeMethod(value string) string {
	switch value {
	case "GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS":
		return value
	default:
		return "OTHER"
	}
}

func normalizeStatusClass(status int) string {
	switch {
	case status >= 100 && status < 200:
		return "1xx"
	case status >= 200 && status < 300:
		return "2xx"
	case status >= 300 && status < 400:
		return "3xx"
	case status >= 400 && status < 500:
		return "4xx"
	default:
		return "5xx"
	}
}

func newRouteSet(values []string) (map[string]struct{}, error) {
	routes := make(map[string]struct{}, len(values))
	for _, value := range values {
		if !validRouteTemplate(value) {
			return nil, errors.New("metrics.route_template_invalid")
		}
		routes[value] = struct{}{}
	}
	return routes, nil
}

func validRouteTemplate(value string) bool {
	if value == "" || len(value) > 512 || value[0] != '/' {
		return false
	}
	for _, char := range value {
		if char == 0 || char == '?' || char == '#' || char == '%' || char == '\\' || unicode.IsControl(char) || unicode.IsSpace(char) {
			return false
		}
	}

	parts := strings.Split(value, "/")
	for index, part := range parts[1:] {
		if part == "" {
			// A trailing slash is a distinct, safe template; interior empty
			// segments are rejected so malformed paths cannot become labels.
			if index != len(parts[1:])-1 {
				return false
			}
			continue
		}
		if strings.HasPrefix(part, "{") || strings.HasSuffix(part, "}") {
			if !validRoutePlaceholder(part) {
				return false
			}
			continue
		}
		if !validStaticRoutePart(part, index == len(parts[1:])-1) {
			return false
		}
	}
	return true
}

func validRoutePlaceholder(value string) bool {
	if len(value) < 3 || value[0] != '{' || value[len(value)-1] != '}' {
		return false
	}
	name := value[1 : len(value)-1]
	if !isASCIINameStart(name[0]) {
		return false
	}
	for index := 1; index < len(name); index++ {
		if !isASCIINamePart(name[index]) {
			return false
		}
	}
	return true
}

func validStaticRoutePart(value string, final bool) bool {
	if value == "*" {
		return final
	}
	for _, char := range value {
		if (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9') || strings.ContainsRune("._~-", char) {
			continue
		}
		return false
	}
	return true
}

func isASCIINameStart(value byte) bool {
	return (value >= 'a' && value <= 'z') || (value >= 'A' && value <= 'Z') || value == '_'
}

func isASCIINamePart(value byte) bool {
	return isASCIINameStart(value) || (value >= '0' && value <= '9') || value == '-'
}

func normalizeWorkerOperation(value WorkerOperation) string {
	switch value {
	case WorkerOperationEmail,
		WorkerOperationNtfy,
		WorkerOperationPresenceExpiry,
		WorkerOperationEchoSolicitationDelivery,
		WorkerOperationEchoRequirementDelivery,
		WorkerOperationEchoReleaseDelivery,
		WorkerOperationEchoMemberReconciliation,
		WorkerOperationUploadStorageMaintenance,
		WorkerOperationMultipartMaintenance:
		return string(value)
	default:
		return string(WorkerOperationOther)
	}
}

func normalizeWorkerResult(value WorkerResultKind) string {
	switch value {
	case WorkerResultEligible,
		WorkerResultClaimed,
		WorkerResultCompleted,
		WorkerResultFailed,
		WorkerResultCancelled,
		WorkerResultRetried,
		WorkerResultLeaseExpired:
		return string(value)
	default:
		return string(WorkerResultOther)
	}
}

func normalizeObjectOperation(value ObjectOperation) string {
	switch value {
	case ObjectOperationOpen,
		ObjectOperationPut,
		ObjectOperationDelete,
		ObjectOperationCleanup,
		ObjectOperationMultipartAbort,
		ObjectOperationVerify,
		ObjectOperationSign:
		return string(value)
	default:
		return string(ObjectOperationOther)
	}
}

func normalizeObjectOutcome(value ObjectOutcome) string {
	switch value {
	case ObjectOutcomeSuccess, ObjectOutcomeFailure:
		return string(value)
	default:
		return string(ObjectOutcomeOther)
	}
}
