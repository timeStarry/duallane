package botgateway

import (
	"encoding/json"
	"errors"
	"math"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

// nodeParsedJSON serializes a JSON request subtree with JSON.parse/stringify
// semantics. Persisted Node idempotency hashes depend on property insertion
// order (except array-index keys), duplicate keys, binary64 numbers and UTF-16
// strings. Decoding into a Go map before hashing loses that information.
// It is not a new wire format, a general JS evaluator, or a payload validator.
// Callers must still apply the owning domain's authorization and size limits.
// References: ECMA-262 JSON.stringify and OrdinaryOwnPropertyKeys.
func nodeParsedJSON(raw []byte) ([]byte, error) {
	// Match the HTTP JSON request budget; json.Valid also bounds nesting at
	// 10,000 levels. All indices below are guarded by that syntax validation.
	if len(raw) == 0 || len(raw) > 1024*1024 || !json.Valid(raw) || !utf8.Valid(raw) {
		return nil, errors.New("invalid gateway JSON subtree")
	}
	parser := nodeJSONParser{raw: raw}
	return parser.value().appendTo(make([]byte, 0, len(raw))), nil
}

// The tree holds each scalar once; render into one output buffer. Building a
// serialized byte slice for every enclosing object would multiply memory by
// nesting depth even though the incoming request itself is bounded.
type nodeJSONValue struct {
	scalar []byte
	array  []*nodeJSONValue
	fields []nodeJSONField
	kind   byte
}

type nodeJSONField struct {
	key   []byte
	value *nodeJSONValue
	index uint64
}

func (v *nodeJSONValue) appendTo(out []byte) []byte {
	switch v.kind {
	case '[':
		out = append(out, '[')
		for index, child := range v.array {
			if index > 0 {
				out = append(out, ',')
			}
			out = child.appendTo(out)
		}
		return append(out, ']')
	case '{':
		out = append(out, '{')
		for index, field := range v.fields {
			if index > 0 {
				out = append(out, ',')
			}
			out = append(out, field.key...)
			out = append(out, ':')
			out = field.value.appendTo(out)
		}
		return append(out, '}')
	default:
		return append(out, v.scalar...)
	}
}

type nodeJSONParser struct {
	raw []byte
	pos int
}

func (p *nodeJSONParser) space() {
	for p.pos < len(p.raw) && (p.raw[p.pos] == ' ' || p.raw[p.pos] == '\n' || p.raw[p.pos] == '\r' || p.raw[p.pos] == '\t') {
		p.pos++
	}
}

func (p *nodeJSONParser) value() *nodeJSONValue {
	p.space()
	switch p.raw[p.pos] {
	case '"':
		return &nodeJSONValue{scalar: quoteNodeString(p.stringUnits())}
	case '{':
		return p.object()
	case '[':
		p.pos++
		p.space()
		out := &nodeJSONValue{kind: '['}
		for p.raw[p.pos] != ']' {
			if len(out.array) > 0 {
				p.pos++ // comma
			}
			out.array = append(out.array, p.value())
			p.space()
		}
		p.pos++
		return out
	case 't':
		p.pos += 4
		return &nodeJSONValue{scalar: []byte("true")}
	case 'f':
		p.pos += 5
		return &nodeJSONValue{scalar: []byte("false")}
	case 'n':
		p.pos += 4
		return &nodeJSONValue{scalar: []byte("null")}
	default:
		start := p.pos
		for p.pos < len(p.raw) && strings.ContainsRune("-+.eE0123456789", rune(p.raw[p.pos])) {
			p.pos++
		}
		number, _ := strconv.ParseFloat(string(p.raw[start:p.pos]), 64)
		if math.IsInf(number, 0) {
			return &nodeJSONValue{scalar: []byte("null")}
		}
		if number == 0 {
			return &nodeJSONValue{scalar: []byte{'0'}} // JSON.stringify(-0) is 0.
		}
		encoded, _ := json.Marshal(number)
		return &nodeJSONValue{scalar: encoded}
	}
}

func (p *nodeJSONParser) object() *nodeJSONValue {
	p.pos++
	p.space()
	fields := make([]nodeJSONField, 0)
	positions := make(map[string]int)
	for p.raw[p.pos] != '}' {
		if len(fields) > 0 {
			p.pos++ // comma
			p.space()
		}
		units := p.stringUnits()
		key := quoteNodeString(units)
		p.space()
		p.pos++ // colon
		value := p.value()
		if index, exists := positions[string(key)]; exists {
			// JSON.parse overwrites a value without moving the property's first
			// insertion position. Compare canonical UTF-16 keys, not Go strings.
			fields[index].value = value
		} else {
			index := uint64(math.MaxUint32)
			plain := string(utf16.Decode(units))
			if parsed, err := strconv.ParseUint(plain, 10, 32); err == nil && parsed < math.MaxUint32 && strconv.FormatUint(parsed, 10) == plain {
				index = parsed
			}
			positions[string(key)] = len(fields)
			fields = append(fields, nodeJSONField{key: key, value: value, index: index})
		}
		p.space()
	}
	p.pos++
	sort.SliceStable(fields, func(i, j int) bool { return fields[i].index < fields[j].index })
	return &nodeJSONValue{kind: '{', fields: fields}
}

func (p *nodeJSONParser) stringUnits() []uint16 {
	p.pos++ // quote
	var units []uint16
	for p.raw[p.pos] != '"' {
		if p.raw[p.pos] == '\\' {
			p.pos++
			character := p.raw[p.pos]
			p.pos++
			switch character {
			case 'u':
				value, _ := strconv.ParseUint(string(p.raw[p.pos:p.pos+4]), 16, 16)
				units = append(units, uint16(value))
				p.pos += 4
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
			default:
				units = append(units, uint16(character))
			}
			continue
		}
		character, size := utf8.DecodeRune(p.raw[p.pos:])
		p.pos += size
		if character <= 0xffff {
			units = append(units, uint16(character))
		} else {
			hi, lo := utf16.EncodeRune(character)
			units = append(units, uint16(hi), uint16(lo))
		}
	}
	p.pos++
	return units
}

func quoteNodeString(units []uint16) []byte {
	out := []byte{'"'}
	const hex = "0123456789abcdef"
	for index := 0; index < len(units); index++ {
		unit := units[index]
		switch unit {
		case '"', '\\':
			out = append(out, '\\', byte(unit))
		case '\b':
			out = append(out, '\\', 'b')
		case '\f':
			out = append(out, '\\', 'f')
		case '\n':
			out = append(out, '\\', 'n')
		case '\r':
			out = append(out, '\\', 'r')
		case '\t':
			out = append(out, '\\', 't')
		default:
			if unit >= 0xd800 && unit <= 0xdbff && index+1 < len(units) && units[index+1] >= 0xdc00 && units[index+1] <= 0xdfff {
				out = utf8.AppendRune(out, utf16.DecodeRune(rune(unit), rune(units[index+1])))
				index++
			} else if unit < 0x20 || unit >= 0xd800 && unit <= 0xdfff {
				out = append(out, '\\', 'u', hex[unit>>12], hex[unit>>8&15], hex[unit>>4&15], hex[unit&15])
			} else {
				out = utf8.AppendRune(out, rune(unit))
			}
		}
	}
	return append(out, '"')
}

func nodeTrimSpace(value string) string {
	return strings.TrimFunc(value, nodeSpace)
}

func nodeSpace(character rune) bool {
	return character == 0x09 || character == 0x0a || character == 0x0b || character == 0x0c || character == 0x0d || character == 0x20 || character == 0xa0 || character == 0x1680 || character >= 0x2000 && character <= 0x200a || character == 0x2028 || character == 0x2029 || character == 0x202f || character == 0x205f || character == 0x3000 || character == 0xfeff
}

func nodeStringLength(value string) int {
	length := 0
	for _, character := range value {
		length++
		if character > 0xffff {
			length++
		}
	}
	return length
}

func nodeTrimmedJSONString(raw []byte) ([]byte, error) {
	if len(raw) > 1024*1024 || !json.Valid(raw) || !utf8.Valid(raw) {
		return nil, errors.New("invalid gateway JSON string")
	}
	p := nodeJSONParser{raw: raw}
	p.space()
	if p.raw[p.pos] != '"' {
		return nil, errors.New("gateway JSON value is not a string")
	}
	units := p.stringUnits()
	for len(units) > 0 && nodeSpace(rune(units[0])) {
		units = units[1:]
	}
	for len(units) > 0 && nodeSpace(rune(units[len(units)-1])) {
		units = units[:len(units)-1]
	}
	return quoteNodeString(units), nil
}
