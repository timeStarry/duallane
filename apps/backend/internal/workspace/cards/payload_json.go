package cards

import "encoding/json"

// ValidatePayloadJSON retains member order and escaped UTF-16 only through a
// registered, type-specific safe canonicalizer. Raw input without that contract
// follows the ordinary typed normalization path and is never stored verbatim.
func (r *Registry) ValidatePayloadJSON(block CardBlock, raw json.RawMessage) (ValidationResult, error) {
	resolved, err := r.Resolve(block)
	if err != nil || resolved.Definition == nil {
		return resolved, err
	}
	definition := resolved.Definition
	parsed, err := normalizeJSONPayload(raw, definition.Limits, definition.AllowPublicURLs)
	if err != nil {
		return ValidationResult{}, err
	}
	if definition.ValidatePayloadJSON == nil {
		return r.ValidatePayload(block, parsed)
	}
	canonical, err := definition.ValidatePayloadJSON(append(json.RawMessage(nil), raw...))
	if err != nil {
		return ValidationResult{}, err
	}
	if _, err := normalizeJSONPayload(canonical, definition.Limits, definition.AllowPublicURLs); err != nil {
		return ValidationResult{}, err
	}
	resolved.Payload = append(json.RawMessage(nil), canonical...)
	return resolved, nil
}

func normalizeJSONPayload(raw json.RawMessage, limits Limits, allowPublicURLs bool) (any, error) {
	limits = normalizeLimits(limits, DefaultLimits)
	if len(raw) > limits.MaxPayloadBytes {
		return nil, &CardValidationError{Code: CodeCardPayloadLarge, Message: "卡片数据过大"}
	}
	var parsed any
	if json.Unmarshal(raw, &parsed) != nil {
		return nil, invalidJSONPayload()
	}
	return NormalizeCardPayload(parsed, limits, allowPublicURLs)
}

func invalidJSONPayload() *CardValidationError {
	return &CardValidationError{Code: CodeCardInvalidPayload, Message: "卡片数据必须是 JSON 值"}
}
