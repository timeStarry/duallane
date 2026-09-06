package botgateway

import (
	"bytes"
	"encoding/json"
	"unicode/utf16"
	"unicode/utf8"
)

// normalizeRawFallbackJSON mirrors the Node gateway's explicit fallback path:
// JSON must contain a string, C0/DEL code units are removed, ECMAScript
// whitespace is trimmed, and the validated UTF-16 units are quoted for the
// idempotency hash. The returned Go string is the replacement-safe value sent
// to the cards/message writers; the raw JSON is hash-only.
func normalizeRawFallbackJSON(raw json.RawMessage) (string, json.RawMessage, error) {
	units, err := parseRawFallbackStringUnits(raw)
	if err != nil {
		return "", nil, invalidFallbackError()
	}
	units = removeFallbackControlUnits(units)
	units = trimFallbackSpaceUnits(units)
	text := string(utf16.Decode(units))
	if len(units) == 0 || len(units) > 16_000 || htmlPattern.MatchString(text) {
		return "", nil, invalidFallbackError()
	}
	return text, cloneRawJSON(quoteNodeString(units)), nil
}

func parseRawFallbackStringUnits(raw []byte) ([]uint16, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || len(trimmed) > 1<<20 || !json.Valid(trimmed) || !utf8.Valid(trimmed) {
		return nil, invalidFallbackError()
	}
	parser := nodeJSONParser{raw: trimmed}
	parser.space()
	if parser.pos >= len(parser.raw) || parser.raw[parser.pos] != '"' {
		return nil, invalidFallbackError()
	}
	units := parser.stringUnits()
	parser.space()
	if parser.pos != len(parser.raw) {
		return nil, invalidFallbackError()
	}
	return units, nil
}

func removeFallbackControlUnits(units []uint16) []uint16 {
	result := make([]uint16, 0, len(units))
	for _, unit := range units {
		if unit <= 0x1f || unit == 0x7f {
			continue
		}
		result = append(result, unit)
	}
	return result
}

func trimFallbackSpaceUnits(units []uint16) []uint16 {
	start := 0
	for start < len(units) && nodeSpace(rune(units[start])) {
		start++
	}
	end := len(units)
	for end > start && nodeSpace(rune(units[end-1])) {
		end--
	}
	return append([]uint16(nil), units[start:end]...)
}

func invalidFallbackError() error {
	return NewError(CodeCardInvalidFallback, "卡片降级文本无效", 400)
}
