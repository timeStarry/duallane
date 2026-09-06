package feishucards

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	whatwgurl "github.com/nlnwa/whatwg-url/url"
)

// The Node converter receives an already parsed JavaScript value, so these
// limits are transport-only guards for the Go raw-JSON boundary. Supported
// Feishu payloads still go through the smaller Node-compatible limits after
// decoding. Keeping the raw guards comfortably above those limits preserves
// the domain error precedence for normal payloads while bounding parser work.
const (
	rawJSONMaxBytes = 1024 * 1024
	rawJSONMaxDepth = 1024
	rawJSONMaxNodes = 100000
)

type jsonKind uint8

const (
	jsonNull jsonKind = iota
	jsonBool
	jsonNumber
	jsonString
	jsonArray
	jsonObject
)

type jsonField struct {
	key      string
	keyUnits []uint16
	value    orderedValue
}

type orderedValue struct {
	kind   jsonKind
	bool   bool
	number float64
	string string
	units  []uint16
	array  []orderedValue
	object []jsonField
}

func parseOrderedJSON(raw []byte) (orderedValue, error) {
	if len(raw) > rawJSONMaxBytes {
		return orderedValue{}, validationError(CodePayloadTooLarge, "卡片数据过大")
	}
	if len(raw) == 0 || !utf8.Valid(raw) || !json.Valid(raw) {
		return orderedValue{}, io.ErrUnexpectedEOF
	}
	parser := orderedJSONParser{raw: raw}
	value, err := parser.value(0)
	if err != nil {
		return orderedValue{}, err
	}
	parser.space()
	if parser.pos != len(raw) {
		return orderedValue{}, io.ErrUnexpectedEOF
	}
	return value, nil
}

type orderedJSONParser struct {
	raw   []byte
	pos   int
	nodes int
}

func (p *orderedJSONParser) space() {
	for p.pos < len(p.raw) {
		switch p.raw[p.pos] {
		case ' ', '\n', '\r', '\t':
			p.pos++
		default:
			return
		}
	}
}

func (p *orderedJSONParser) value(depth int) (orderedValue, error) {
	p.space()
	if p.pos >= len(p.raw) {
		return orderedValue{}, io.ErrUnexpectedEOF
	}
	if depth > rawJSONMaxDepth {
		return orderedValue{}, validationError(CodePayloadTooDeep, "卡片嵌套深度超限")
	}
	p.nodes++
	if p.nodes > rawJSONMaxNodes {
		return orderedValue{}, validationError(CodePayloadTooComplex, "卡片节点数量超限")
	}
	switch p.raw[p.pos] {
	case 'n':
		if !p.consumeLiteral("null") {
			return orderedValue{}, io.ErrUnexpectedEOF
		}
		return orderedValue{kind: jsonNull}, nil
	case 't':
		if !p.consumeLiteral("true") {
			return orderedValue{}, io.ErrUnexpectedEOF
		}
		return orderedValue{kind: jsonBool, bool: true}, nil
	case 'f':
		if !p.consumeLiteral("false") {
			return orderedValue{}, io.ErrUnexpectedEOF
		}
		return orderedValue{kind: jsonBool, bool: false}, nil
	case '"':
		units, err := p.stringUnits()
		if err != nil {
			return orderedValue{}, err
		}
		return orderedValue{kind: jsonString, string: string(utf16.Decode(units)), units: units}, nil
	case '[':
		return p.array(depth)
	case '{':
		return p.object(depth)
	default:
		return p.number()
	}
}

func (p *orderedJSONParser) consumeLiteral(literal string) bool {
	if len(p.raw)-p.pos < len(literal) || string(p.raw[p.pos:p.pos+len(literal)]) != literal {
		return false
	}
	p.pos += len(literal)
	return true
}

func (p *orderedJSONParser) number() (orderedValue, error) {
	start := p.pos
	for p.pos < len(p.raw) && strings.ContainsRune("-+.eE0123456789", rune(p.raw[p.pos])) {
		p.pos++
	}
	if start == p.pos {
		return orderedValue{}, io.ErrUnexpectedEOF
	}
	number, err := strconv.ParseFloat(string(p.raw[start:p.pos]), 64)
	if err != nil && !errors.Is(err, strconv.ErrRange) {
		return orderedValue{}, &ValidationError{Code: CodeInvalidPayload, Message: "卡片数据包含无效数字"}
	}
	if math.IsNaN(number) || math.IsInf(number, 0) {
		// JSON.parse produces Infinity for an exponent outside binary64's
		// finite range. Keep that value until normalization so the same
		// card.invalid_payload validation path as Node is selected instead of
		// silently turning it into null.
		return orderedValue{kind: jsonNumber, number: number}, nil
	}
	return orderedValue{kind: jsonNumber, number: number}, nil
}

func (p *orderedJSONParser) array(depth int) (orderedValue, error) {
	p.pos++
	p.space()
	result := orderedValue{kind: jsonArray}
	if p.pos < len(p.raw) && p.raw[p.pos] == ']' {
		p.pos++
		return result, nil
	}
	for {
		child, err := p.value(depth + 1)
		if err != nil {
			return orderedValue{}, err
		}
		result.array = append(result.array, child)
		p.space()
		if p.pos >= len(p.raw) {
			return orderedValue{}, io.ErrUnexpectedEOF
		}
		if p.raw[p.pos] == ']' {
			p.pos++
			return result, nil
		}
		if p.raw[p.pos] != ',' {
			return orderedValue{}, io.ErrUnexpectedEOF
		}
		p.pos++
		p.space()
	}
}

func (p *orderedJSONParser) object(depth int) (orderedValue, error) {
	p.pos++
	p.space()
	result := orderedValue{kind: jsonObject}
	positions := make(map[string]int)
	if p.pos < len(p.raw) && p.raw[p.pos] == '}' {
		p.pos++
		return result, nil
	}
	for {
		if p.pos >= len(p.raw) || p.raw[p.pos] != '"' {
			return orderedValue{}, io.ErrUnexpectedEOF
		}
		units, err := p.stringUnits()
		if err != nil {
			return orderedValue{}, err
		}
		key := string(utf16.Decode(units))
		keyBytes, err := marshalNodeStringUnits(units, key)
		if err != nil {
			return orderedValue{}, err
		}
		p.space()
		if p.pos >= len(p.raw) || p.raw[p.pos] != ':' {
			return orderedValue{}, io.ErrUnexpectedEOF
		}
		p.pos++
		child, err := p.value(depth + 1)
		if err != nil {
			return orderedValue{}, err
		}
		if index, exists := positions[string(keyBytes)]; exists {
			// JSON.parse overwrites a duplicate value without moving the
			// property's first insertion position. Compare canonical UTF-16
			// keys, not decoded Go strings.
			result.object[index].value = child
		} else {
			positions[string(keyBytes)] = len(result.object)
			result.object = append(result.object, jsonField{key: key, keyUnits: units, value: child})
		}
		p.space()
		if p.pos >= len(p.raw) {
			return orderedValue{}, io.ErrUnexpectedEOF
		}
		if p.raw[p.pos] == '}' {
			p.pos++
			orderJavaScriptObjectKeys(result.object)
			return result, nil
		}
		if p.raw[p.pos] != ',' {
			return orderedValue{}, io.ErrUnexpectedEOF
		}
		p.pos++
		p.space()
	}
}

func (p *orderedJSONParser) stringUnits() ([]uint16, error) {
	if p.pos >= len(p.raw) || p.raw[p.pos] != '"' {
		return nil, io.ErrUnexpectedEOF
	}
	p.pos++
	var units []uint16
	for p.pos < len(p.raw) {
		character := p.raw[p.pos]
		switch character {
		case '"':
			p.pos++
			return units, nil
		case '\\':
			p.pos++
			if p.pos >= len(p.raw) {
				return nil, io.ErrUnexpectedEOF
			}
			escape := p.raw[p.pos]
			p.pos++
			switch escape {
			case '"', '\\', '/':
				units = append(units, uint16(escape))
			case 'b':
				units = append(units, '\b')
			case 'f':
				units = append(units, '\f')
			case 'n':
				units = append(units, '\n')
			case 'r':
				units = append(units, '\r')
			case 't':
				units = append(units, '\t')
			case 'u':
				if len(p.raw)-p.pos < 4 {
					return nil, io.ErrUnexpectedEOF
				}
				parsed, err := strconv.ParseUint(string(p.raw[p.pos:p.pos+4]), 16, 16)
				if err != nil {
					return nil, io.ErrUnexpectedEOF
				}
				units = append(units, uint16(parsed))
				p.pos += 4
			default:
				return nil, io.ErrUnexpectedEOF
			}
		case 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f:
			return nil, io.ErrUnexpectedEOF
		default:
			character, size := utf8.DecodeRune(p.raw[p.pos:])
			if character == utf8.RuneError && size == 1 {
				return nil, io.ErrUnexpectedEOF
			}
			if character <= 0xffff {
				units = append(units, uint16(character))
			} else {
				high, low := utf16.EncodeRune(character)
				units = append(units, uint16(high), uint16(low))
			}
			p.pos += size
		}
	}
	return nil, io.ErrUnexpectedEOF
}

func orderJavaScriptObjectKeys(fields []jsonField) {
	sort.SliceStable(fields, func(left, right int) bool {
		leftIndex, leftIsIndex := javascriptArrayIndexUnits(fields[left].keyUnits, fields[left].key)
		rightIndex, rightIsIndex := javascriptArrayIndexUnits(fields[right].keyUnits, fields[right].key)
		if leftIsIndex != rightIsIndex {
			return leftIsIndex
		}
		return leftIsIndex && leftIndex < rightIndex
	})
}

func javascriptArrayIndexUnits(units []uint16, fallback string) (uint64, bool) {
	if units == nil {
		return javascriptArrayIndex(fallback)
	}
	return javascriptArrayIndex(string(utf16.Decode(units)))
}

func javascriptArrayIndex(value string) (uint64, bool) {
	if value == "" {
		return 0, false
	}
	parsed, err := strconv.ParseUint(value, 10, 32)
	if err != nil || parsed >= math.MaxUint32 || strconv.FormatUint(parsed, 10) != value {
		return 0, false
	}
	return parsed, true
}

func (value orderedValue) field(key string) (orderedValue, bool) {
	if value.kind != jsonObject {
		return orderedValue{}, false
	}
	for index := len(value.object) - 1; index >= 0; index-- {
		if value.object[index].key == key {
			return value.object[index].value, true
		}
	}
	return orderedValue{}, false
}

func objectValue(value orderedValue, code, message string) (orderedValue, error) {
	if value.kind != jsonObject {
		return orderedValue{}, validationError(code, message)
	}
	return value, nil
}

func arrayValue(value orderedValue, code, message string) ([]orderedValue, error) {
	if value.kind != jsonArray {
		return nil, validationError(code, message)
	}
	return value.array, nil
}

func stringValue(value orderedValue) (string, bool) {
	if value.kind != jsonString {
		return "", false
	}
	// This is the comparison/typed-projection view. Canonical output must use
	// valueUnits so lone UTF-16 code units are not replaced by U+FFFD.
	return value.string, true
}

func cloneUnits(value []uint16) []uint16 {
	return append([]uint16(nil), value...)
}

func valueUnits(value orderedValue) []uint16 {
	if value.units != nil {
		return cloneUnits(value.units)
	}
	return utf16Units(value.string)
}

func boolValue(value orderedValue) (bool, bool) {
	if value.kind != jsonBool {
		return false, false
	}
	return value.bool, true
}

func makeObject(fields ...jsonField) orderedValue {
	return orderedValue{kind: jsonObject, object: fields}
}

func makeArray(values ...orderedValue) orderedValue {
	return orderedValue{kind: jsonArray, array: values}
}

func makeString(value string) orderedValue {
	return makeStringUnits(utf16Units(value), value)
}

func makeStringUnits(units []uint16, fallback string) orderedValue {
	return orderedValue{kind: jsonString, string: fallback, units: cloneUnits(units)}
}

func makeBool(value bool) orderedValue {
	return orderedValue{kind: jsonBool, bool: value}
}

func makeNumber(value float64) orderedValue {
	return orderedValue{kind: jsonNumber, number: value}
}

func (value orderedValue) marshalJSON() ([]byte, error) {
	var output bytes.Buffer
	if err := writeOrderedJSON(&output, value); err != nil {
		return nil, err
	}
	return output.Bytes(), nil
}

func writeOrderedJSON(output *bytes.Buffer, value orderedValue) error {
	switch value.kind {
	case jsonNull:
		output.WriteString("null")
	case jsonBool:
		if value.bool {
			output.WriteString("true")
		} else {
			output.WriteString("false")
		}
	case jsonNumber:
		if math.IsNaN(value.number) || math.IsInf(value.number, 0) {
			return validationError(CodeInvalidPayload, "卡片数据包含无效数字")
		}
		output.WriteString(formatNodeNumber(value.number))
	case jsonString:
		encoded, err := marshalNodeStringUnits(value.units, value.string)
		if err != nil {
			return err
		}
		output.Write(encoded)
	case jsonArray:
		output.WriteByte('[')
		for index, child := range value.array {
			if index > 0 {
				output.WriteByte(',')
			}
			if err := writeOrderedJSON(output, child); err != nil {
				return err
			}
		}
		output.WriteByte(']')
	case jsonObject:
		output.WriteByte('{')
		for index, field := range value.object {
			if index > 0 {
				output.WriteByte(',')
			}
			key, err := marshalNodeStringUnits(field.keyUnits, field.key)
			if err != nil {
				return err
			}
			output.Write(key)
			output.WriteByte(':')
			if err := writeOrderedJSON(output, field.value); err != nil {
				return err
			}
		}
		output.WriteByte('}')
	default:
		return validationError(CodeInvalidPayload, "卡片数据必须是 JSON 值")
	}
	return nil
}

func marshalNodeStringUnits(units []uint16, fallback string) ([]byte, error) {
	if units == nil {
		if !utf8.ValidString(fallback) {
			return nil, validationError(CodeInvalidPayload, "卡片数据必须是 JSON 值")
		}
		units = utf16Units(fallback)
	}
	const hex = "0123456789abcdef"
	encoded := make([]byte, 0, len(units)+2)
	encoded = append(encoded, '"')
	for index := 0; index < len(units); index++ {
		unit := units[index]
		switch unit {
		case '"', '\\':
			encoded = append(encoded, '\\', byte(unit))
		case '\b':
			encoded = append(encoded, '\\', 'b')
		case '\f':
			encoded = append(encoded, '\\', 'f')
		case '\n':
			encoded = append(encoded, '\\', 'n')
		case '\r':
			encoded = append(encoded, '\\', 'r')
		case '\t':
			encoded = append(encoded, '\\', 't')
		default:
			if unit >= 0xd800 && unit <= 0xdbff && index+1 < len(units) && units[index+1] >= 0xdc00 && units[index+1] <= 0xdfff {
				encoded = utf8.AppendRune(encoded, utf16.DecodeRune(rune(unit), rune(units[index+1])))
				index++
			} else if unit < 0x20 || unit >= 0xd800 && unit <= 0xdfff {
				encoded = append(encoded, '\\', 'u', hex[unit>>12], hex[unit>>8&15], hex[unit>>4&15], hex[unit&15])
			} else {
				encoded = utf8.AppendRune(encoded, rune(unit))
			}
		}
	}
	return append(encoded, '"'), nil
}

func utf16Units(value string) []uint16 {
	units := make([]uint16, 0, len(value))
	for _, character := range value {
		if character <= 0xffff {
			units = append(units, uint16(character))
		} else {
			high, low := utf16.EncodeRune(character)
			units = append(units, uint16(high), uint16(low))
		}
	}
	return units
}

func formatNodeNumber(value float64) string {
	if value == 0 {
		return "0"
	}
	encoded := strconv.FormatFloat(value, 'g', -1, 64)
	if !strings.ContainsAny(encoded, "eE") {
		return encoded
	}
	mantissa, exponentText, _ := strings.Cut(strings.ToLower(encoded), "e")
	exponent, _ := strconv.Atoi(exponentText)
	// JavaScript uses decimal notation for [1e-6, 1e21).
	if exponent >= -6 && exponent < 21 {
		return expandDecimal(mantissa, exponent)
	}
	parts := strings.SplitN(mantissa, ".", 2)
	if len(parts) == 2 && strings.TrimRight(parts[1], "0") == "" {
		mantissa = parts[0]
	}
	sign := "+"
	if exponent < 0 {
		sign = "-"
		exponent = -exponent
	}
	return mantissa + "e" + sign + strconv.Itoa(exponent)
}

func expandDecimal(mantissa string, exponent int) string {
	sign := ""
	if strings.HasPrefix(mantissa, "-") {
		sign = "-"
		mantissa = strings.TrimPrefix(mantissa, "-")
	}
	parts := strings.SplitN(mantissa, ".", 2)
	digits := parts[0]
	if len(parts) == 2 {
		digits += parts[1]
	}
	decimal := len(parts[0]) + exponent
	if decimal <= 0 {
		return sign + "0." + strings.Repeat("0", -decimal) + digits
	}
	if decimal >= len(digits) {
		return sign + digits + strings.Repeat("0", decimal-len(digits))
	}
	return sign + digits[:decimal] + "." + digits[decimal:]
}

var (
	fieldPattern       = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,128}$`)
	htmlPattern        = regexp.MustCompile(`(?i)</?[a-z][^>]*>`)
	unsafeTextPattern  = regexp.MustCompile(`(?i)(?:javascript|vbscript|data)\s*:|\bon[a-z][a-z0-9_-]*\s*=|\b(?:eval|function|settimeout|setinterval)\s*\(`)
	urlPattern         = regexp.MustCompile(`(?i)(?:https?://|//)[^\s<>()]+`)
	anchoredURLPattern = regexp.MustCompile(`(?i)^(?:(?:https?|ftp|file|data|javascript|vbscript):|//)`)
	privateHostSuffix  = regexp.MustCompile(`(?i)(?:^|\.)(?:localhost|local|internal|home|lan)$`)
	urlFieldPattern    = regexp.MustCompile(`(?i)(callback|webhook|actionurl|targeturl|href|uri|url)$`)
)

type normalizationState struct {
	nodes     int
	textBytes int
	limits    Limits
}

func normalizeLimits(value, fallback Limits) Limits {
	if value.MaxDepth <= 0 {
		value.MaxDepth = fallback.MaxDepth
	}
	if value.MaxNodes <= 0 {
		value.MaxNodes = fallback.MaxNodes
	}
	if value.MaxTextBytes <= 0 {
		value.MaxTextBytes = fallback.MaxTextBytes
	}
	if value.MaxPayloadBytes <= 0 {
		value.MaxPayloadBytes = fallback.MaxPayloadBytes
	}
	return value
}

func normalizePayload(value orderedValue, limits Limits, allowPublicURLs bool) (orderedValue, error) {
	limits = normalizeLimits(limits, DefaultLimits)
	state := normalizationState{limits: limits}
	result, err := normalizeValue(value, &state, allowPublicURLs, "payload", 0)
	if err != nil {
		return orderedValue{}, err
	}
	encoded, err := result.marshalJSON()
	if err != nil {
		return orderedValue{}, err
	}
	if len(encoded) > limits.MaxPayloadBytes {
		return orderedValue{}, validationError(CodePayloadTooLarge, "卡片数据过大")
	}
	return result, nil
}

func normalizeValue(value orderedValue, state *normalizationState, allowPublicURLs bool, path string, depth int) (orderedValue, error) {
	state.nodes++
	if state.nodes > state.limits.MaxNodes {
		return orderedValue{}, validationError(CodePayloadTooComplex, "卡片节点数量超限")
	}
	if depth > state.limits.MaxDepth {
		return orderedValue{}, validationError(CodePayloadTooDeep, "卡片嵌套深度超限")
	}
	switch value.kind {
	case jsonNull, jsonBool, jsonNumber:
		return value, nil
	case jsonString:
		state.textBytes += len([]byte(value.string))
		if state.textBytes > state.limits.MaxTextBytes {
			return orderedValue{}, validationError(CodeTextTooLarge, "卡片文本超限")
		}
		if htmlPattern.MatchString(value.string) || unsafeTextPattern.MatchString(value.string) {
			return orderedValue{}, validationError(CodeUnsafeContent, "卡片字段 "+path+" 包含不安全内容")
		}
		if anchoredURLPattern.MatchString(nodeTrimSpace(value.string)) {
			if err := assertSafeURL(value.string, allowPublicURLs); err != nil {
				return orderedValue{}, err
			}
		}
		return value, nil
	case jsonArray:
		result := make([]orderedValue, len(value.array))
		for index, child := range value.array {
			converted, err := normalizeValue(child, state, allowPublicURLs, ""+path+"["+strconv.Itoa(index)+"]", depth+1)
			if err != nil {
				return orderedValue{}, err
			}
			result[index] = converted
		}
		value.array = result
		return value, nil
	case jsonObject:
		result := make([]jsonField, len(value.object))
		for index, field := range value.object {
			if !fieldPattern.MatchString(field.key) || field.key == "__proto__" || field.key == "constructor" || field.key == "prototype" {
				return orderedValue{}, validationError(CodeInvalidPayload, "卡片字段名无效")
			}
			if !allowPublicURLs && urlFieldPattern.MatchString(field.key) && field.value.kind == jsonString && looksLikeURL(field.value.string) {
				return orderedValue{}, validationError(CodeURLForbidden, "卡片不允许未注册的 URL 操作")
			}
			converted, err := normalizeValue(field.value, state, allowPublicURLs, path+"."+field.key, depth+1)
			if err != nil {
				return orderedValue{}, err
			}
			result[index] = jsonField{key: field.key, keyUnits: field.keyUnits, value: converted}
		}
		value.object = result
		return value, nil
	default:
		return orderedValue{}, validationError(CodeInvalidPayload, "卡片数据必须是 JSON 值")
	}
}

func looksLikeURL(value string) bool {
	return anchoredURLPattern.MatchString(nodeTrimSpace(value))
}

func assertSafeURL(value string, allowPublicURLs bool) error {
	parsedValue := value
	trimmed := nodeTrimSpace(parsedValue)
	if strings.HasPrefix(trimmed, "//") {
		parsedValue = "https:" + trimmed
	}
	parsed, err := whatwgurl.Parse(parsedValue)
	if err != nil || parsed.Hostname() == "" {
		return validationError(CodeInvalidURL, "卡片 URL 无效")
	}
	protocol := strings.ToLower(parsed.Scheme())
	if protocol != "http" && protocol != "https" {
		return validationError(CodeURLForbidden, "卡片仅允许 HTTP(S) URL")
	}
	host := strings.ToLower(strings.TrimSuffix(strings.Trim(parsed.Hostname(), "[]"), "."))
	if parsed.Username() != "" || parsed.Password() != "" || isPrivateHost(host) {
		return validationError(CodePrivateURL, "卡片不允许访问私有地址")
	}
	if !allowPublicURLs && host != "duallane.invalid" {
		return validationError(CodeURLForbidden, "卡片不允许未注册的 URL 操作")
	}
	return nil
}

func assertPublicHTTPSURL(value string) error {
	trimmed := nodeTrimSpace(value)
	if strings.HasPrefix(trimmed, "//") {
		trimmed = "https:" + trimmed
	}
	parsed, err := whatwgurl.Parse(trimmed)
	if err != nil || parsed.Hostname() == "" {
		return validationError(CodeInvalidURL, "飞书卡片 URL 无效")
	}
	host := strings.ToLower(strings.TrimSuffix(strings.Trim(parsed.Hostname(), "[]"), "."))
	if strings.ToLower(parsed.Scheme()) != "https" || parsed.Username() != "" || parsed.Password() != "" {
		return validationError(CodeURLForbidden, "飞书卡片仅允许无凭据的 HTTPS URL")
	}
	if isPrivateHost(host) {
		return validationError(CodePrivateURL, "飞书卡片不允许私网 URL")
	}
	return nil
}

func isPrivateHost(host string) bool {
	if host == "" || privateHostSuffix.MatchString(host) {
		return true
	}
	normalized := strings.ToLower(host)
	parsed := net.ParseIP(host)
	if parsed == nil {
		return false
	}
	// Node rejects IPv4-mapped IPv6 hosts even when the mapped address is
	// public. Check the textual IPv6 form before To4 collapses it.
	if strings.Contains(normalized, ":") && parsed.To4() != nil {
		return true
	}
	if ipv4 := parsed.To4(); ipv4 != nil {
		return privateIPv4(ipv4)
	}
	return normalized == "::" || normalized == "::1" || strings.HasPrefix(normalized, "::ffff:") || strings.HasPrefix(normalized, "fc") || strings.HasPrefix(normalized, "fd") || strings.HasPrefix(normalized, "fe8") || strings.HasPrefix(normalized, "fe9") || strings.HasPrefix(normalized, "fea") || strings.HasPrefix(normalized, "feb")
}

func privateIPv4(ipv4 net.IP) bool {
	a, b := ipv4[0], ipv4[1]
	return a == 0 || a == 10 || a == 127 || (a == 169 && b == 254) || (a == 172 && b >= 16 && b <= 31) || (a == 192 && b == 168) || a >= 224
}

type normalizedText struct {
	text  string
	units []uint16
}

func (value normalizedText) orderedValue() orderedValue {
	return makeStringUnits(value.units, value.text)
}

func normalizeText(value orderedValue, state *convertState) (normalizedText, error) {
	if _, ok := stringValue(value); !ok {
		return normalizedText{}, validationError(CodeInvalidText, "飞书卡片文本无效")
	}
	units := trimNodeSpaceUnits(removeTextControlUnits(valueUnits(value)))
	text := string(utf16.Decode(units))
	if text == "" || htmlPattern.MatchString(text) || unsafeTextPattern.MatchString(text) {
		return normalizedText{}, validationError(CodeUnsafeContent, "飞书卡片文本包含不安全内容")
	}
	state.textBytes += len([]byte(text))
	if state.textBytes > state.limits.MaxTextBytes {
		return normalizedText{}, validationError(CodeTextTooLarge, "卡片文本超限")
	}
	for _, match := range urlPattern.FindAllString(text, -1) {
		if err := assertPublicHTTPSURL(match); err != nil {
			return normalizedText{}, err
		}
	}
	return normalizedText{text: text, units: units}, nil
}

func removeTextControlUnits(value []uint16) []uint16 {
	result := make([]uint16, 0, len(value))
	for _, unit := range value {
		if unit <= 0x08 || unit == 0x0b || unit == 0x0c || unit >= 0x0e && unit <= 0x1f || unit == 0x7f {
			continue
		}
		result = append(result, unit)
	}
	return result
}

func nodeTrimSpace(value string) string {
	return strings.TrimFunc(value, func(character rune) bool {
		if character == 0x09 || character == 0x0a || character == 0x0b || character == 0x0c || character == 0x0d || character == 0x20 || character == 0xa0 || character == 0x1680 || character >= 0x2000 && character <= 0x200a || character == 0x2028 || character == 0x2029 || character == 0x202f || character == 0x205f || character == 0x3000 || character == 0xfeff {
			return true
		}
		return false
	})
}

func trimNodeSpaceUnits(value []uint16) []uint16 {
	start := 0
	for start < len(value) {
		character, size := decodeUTF16Unit(value, start)
		if !isNodeTrimSpace(character) {
			break
		}
		start += size
	}
	end := len(value)
	for end > start {
		character, size := decodeUTF16Unit(value, end-sizeOfLastUTF16Unit(value, end))
		if !isNodeTrimSpace(character) {
			break
		}
		end -= size
	}
	return cloneUnits(value[start:end])
}

func decodeUTF16Unit(value []uint16, index int) (rune, int) {
	unit := value[index]
	if unit >= 0xd800 && unit <= 0xdbff && index+1 < len(value) {
		low := value[index+1]
		if low >= 0xdc00 && low <= 0xdfff {
			return utf16.DecodeRune(rune(unit), rune(low)), 2
		}
	}
	if unit >= 0xd800 && unit <= 0xdfff {
		return utf8.RuneError, 1
	}
	return rune(unit), 1
}

func sizeOfLastUTF16Unit(value []uint16, end int) int {
	if end >= 2 {
		high, low := value[end-2], value[end-1]
		if high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff {
			return 2
		}
	}
	return 1
}

func isNodeTrimSpace(character rune) bool {
	return character == 0x09 || character == 0x0a || character == 0x0b || character == 0x0c || character == 0x0d || character == 0x20 || character == 0xa0 || character == 0x1680 || character >= 0x2000 && character <= 0x200a || character == 0x2028 || character == 0x2029 || character == 0x202f || character == 0x205f || character == 0x3000 || character == 0xfeff
}
