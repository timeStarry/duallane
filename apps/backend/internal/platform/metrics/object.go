package metrics

// ObjectOperation is a fixed, non-secret object-store operation category.
type ObjectOperation string

const (
	ObjectOperationOpen           ObjectOperation = "open"
	ObjectOperationPut            ObjectOperation = "put"
	ObjectOperationDelete         ObjectOperation = "delete"
	ObjectOperationCleanup        ObjectOperation = "cleanup"
	ObjectOperationMultipartAbort ObjectOperation = "multipart_abort"
	ObjectOperationVerify         ObjectOperation = "verify"
	ObjectOperationSign           ObjectOperation = "sign"
	ObjectOperationOther          ObjectOperation = "other"
)

// ObjectOutcome is a fixed result category for an object operation.
type ObjectOutcome string

const (
	ObjectOutcomeSuccess ObjectOutcome = "success"
	ObjectOutcomeFailure ObjectOutcome = "failure"
	ObjectOutcomeOther   ObjectOutcome = "other"
)

// ObserveObject records a fixed object operation and byte count. The byte
// count is clamped to zero and no key, URL, user, or raw error is accepted.
func (m *Metrics) ObserveObject(service Service, operation ObjectOperation, outcome ObjectOutcome, bytes int64) {
	if m == nil {
		return
	}
	if bytes < 0 {
		bytes = 0
	}
	serviceLabel := normalizeService(service)
	operationLabel := normalizeObjectOperation(operation)
	outcomeLabel := normalizeObjectOutcome(outcome)
	m.objectOperations.WithLabelValues(serviceLabel, operationLabel, outcomeLabel).Inc()
	m.objectBytes.WithLabelValues(serviceLabel, operationLabel, outcomeLabel).Add(float64(bytes))
}
