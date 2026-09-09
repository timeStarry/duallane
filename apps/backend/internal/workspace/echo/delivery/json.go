package delivery

import "encoding/json"

// MarshalJSON preserves Node's status-dependent operational DTO. A successful
// replay still includes explicit null references and a false/true replay flag.
func (result DeliveryResult) MarshalJSON() ([]byte, error) {
	value := map[string]any{"status": result.Status}
	if result.DeliveryID != "" {
		value["deliveryId"] = result.DeliveryID
	}
	if result.RecipientUserID != "" {
		value["recipientUserId"] = result.RecipientUserID
	}
	if result.Status == DeliverySent {
		value["cardId"], value["messageId"] = nullableReference(result.CardID), nullableReference(result.MessageID)
		value["replayed"] = result.Replayed
	} else if result.ErrorCode != "" {
		value["errorCode"] = result.ErrorCode
	}
	return json.Marshal(value)
}

func (summary DeliverySummary) MarshalJSON() ([]byte, error) {
	results := summary.Results
	if results == nil {
		results = []DeliveryResult{}
	}
	value := map[string]any{"type": summary.Type, "results": results, "sent": summary.Sent, "failed": summary.Failed, "skipped": summary.Skipped}
	if summary.Type == DeliveryTypeRelease {
		value["version"] = summary.Key
	} else {
		value["publicId"] = summary.Key
	}
	return json.Marshal(value)
}

func nullableReference(value string) any {
	if value == "" {
		return nil
	}
	return value
}
