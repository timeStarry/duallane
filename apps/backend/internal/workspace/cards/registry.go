package cards

import (
	"encoding/json"
	"fmt"
	"math"
	"net"
	"net/url"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"
)

var (
	identifierPattern  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
	cardTypePattern    = regexp.MustCompile(`^[a-z][a-z0-9._-]{0,127}$`)
	fieldPattern       = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,128}$`)
	htmlPattern        = regexp.MustCompile(`(?i)</?[a-z][^>]*>`)
	scriptPattern      = regexp.MustCompile(`(?i)(^|[\s<])(?:javascript|vbscript)\s*:`)
	eventPattern       = regexp.MustCompile(`(?i)\bon[a-z][a-z0-9_-]*\s*=`)
	dynamicCodePattern = regexp.MustCompile(`(?i)(^|[^a-z])(?:eval|function|settimeout|setinterval)\s*\(`)
	urlPattern         = regexp.MustCompile(`(?i)^(?:(?:https?|ftp|file|data|javascript|vbscript):|//)`)
	privateHostPattern = regexp.MustCompile(`(?i)^(?:localhost(?:\.local)?|0\.0\.0\.0|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|169\.254(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2}|::1|fc[0-9a-f]{2}:|fd[0-9a-f]{2}:|fe80:)`)
)

func NormalizeIdentifier(value, code, message string) (string, error) {
	normalized := strings.TrimSpace(value)
	if !identifierPattern.MatchString(normalized) {
		return "", &CardValidationError{Code: code, Message: message}
	}
	return normalized, nil
}

func NormalizeCardType(value string) (string, error) {
	normalized := strings.ToLower(strings.TrimSpace(value))
	if !cardTypePattern.MatchString(normalized) {
		return "", &CardValidationError{Code: CodeCardInvalidType, Message: "卡片类型无效"}
	}
	return normalized, nil
}

func NormalizeSchemaVersion(value int) (int, error) {
	if value < 1 || value > 1_000_000 {
		return 0, &CardValidationError{Code: CodeCardInvalidVersion, Message: "卡片版本无效"}
	}
	return value, nil
}

func NormalizeFallbackText(value string) (string, error) {
	value = strings.TrimSpace(strings.Map(func(r rune) rune {
		if (r < 0x20 && r != '\t' && r != '\n' && r != '\r') || r == 0x7f {
			return -1
		}
		return r
	}, value))
	if value == "" || !utf8.ValidString(value) || len([]byte(value)) > MaxPayloadTextBytes || htmlPattern.MatchString(value) {
		return "", &CardValidationError{Code: CodeCardInvalidFallback, Message: "卡片降级文本无效"}
	}
	return value, nil
}

func NormalizeCardBlock(block CardBlock) (CardBlock, error) {
	if block.Type != CardBlockType {
		return CardBlock{}, &CardValidationError{Code: CodeCardInvalidBlock, Message: "卡片消息块格式无效"}
	}
	cardID, err := NormalizeIdentifier(block.CardID, CodeCardInvalidID, "卡片 ID 无效")
	if err != nil {
		return CardBlock{}, err
	}
	cardType, err := NormalizeCardType(block.CardType)
	if err != nil {
		return CardBlock{}, err
	}
	version, err := NormalizeSchemaVersion(block.SchemaVersion)
	if err != nil {
		return CardBlock{}, err
	}
	fallback, err := NormalizeFallbackText(block.FallbackText)
	if err != nil {
		return CardBlock{}, err
	}
	return CardBlock{Type: CardBlockType, CardID: cardID, CardType: cardType, SchemaVersion: version, FallbackText: fallback}, nil
}

func IsWorkspaceV1ContentBlock(block map[string]any) bool {
	value, ok := block["type"].(string)
	if !ok {
		return false
	}
	for _, allowed := range WorkspaceV1BlockTypes {
		if value == allowed {
			return true
		}
	}
	return false
}

func NormalizeCardPayload(payload any, limits Limits, allowPublicURLs bool) (any, error) {
	limits = normalizeLimits(limits, DefaultLimits)
	state := payloadState{}
	result, err := visitPayload(reflect.ValueOf(payload), &state, limits, allowPublicURLs, "payload", 0)
	if err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		return nil, &CardValidationError{Code: CodeCardInvalidPayload, Message: "卡片数据必须是 JSON 值"}
	}
	if len(encoded) > limits.MaxPayloadBytes {
		return nil, &CardValidationError{Code: CodeCardPayloadLarge, Message: "卡片数据过大"}
	}
	return result, nil
}

func normalizeLimits(value, fallback Limits) Limits {
	if value.MaxPayloadBytes <= 0 {
		value.MaxPayloadBytes = fallback.MaxPayloadBytes
	}
	if value.MaxDepth <= 0 {
		value.MaxDepth = fallback.MaxDepth
	}
	if value.MaxNodes <= 0 {
		value.MaxNodes = fallback.MaxNodes
	}
	if value.MaxTextBytes <= 0 {
		value.MaxTextBytes = fallback.MaxTextBytes
	}
	return value
}

type payloadState struct{ nodes, textBytes int }

func visitPayload(value reflect.Value, state *payloadState, limits Limits, allowPublicURLs bool, path string, depth int) (any, error) {
	state.nodes++
	if state.nodes > limits.MaxNodes {
		return nil, &CardValidationError{Code: CodeCardPayloadComplex, Message: "卡片节点数量超限"}
	}
	if depth > limits.MaxDepth {
		return nil, &CardValidationError{Code: CodeCardPayloadDeep, Message: "卡片嵌套深度超限"}
	}
	if !value.IsValid() {
		return nil, nil
	}
	for value.Kind() == reflect.Interface || value.Kind() == reflect.Pointer {
		if value.IsNil() {
			return nil, nil
		}
		value = value.Elem()
	}
	switch value.Kind() {
	case reflect.Bool:
		return value.Bool(), nil
	case reflect.String:
		return normalizePayloadString(value.String(), state, limits, allowPublicURLs, path)
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return value.Int(), nil
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return value.Uint(), nil
	case reflect.Float32, reflect.Float64:
		v := value.Float()
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return nil, &CardValidationError{Code: CodeCardInvalidPayload, Message: "卡片数据包含无效数字"}
		}
		return v, nil
	case reflect.Slice, reflect.Array:
		if value.Type().Elem().Kind() == reflect.Uint8 {
			return nil, &CardValidationError{Code: CodeCardInvalidPayload, Message: "卡片数据必须是 JSON 值"}
		}
		result := make([]any, value.Len())
		for i := 0; i < value.Len(); i++ {
			child, err := visitPayload(value.Index(i), state, limits, allowPublicURLs, fmt.Sprintf("%s[%d]", path, i), depth+1)
			if err != nil {
				return nil, err
			}
			result[i] = child
		}
		return result, nil
	case reflect.Map:
		if value.Type().Key().Kind() != reflect.String {
			return nil, &CardValidationError{Code: CodeCardInvalidPayload, Message: "卡片数据必须是 JSON 值"}
		}
		keys := value.MapKeys()
		result := make(map[string]any, len(keys))
		for _, key := range keys {
			name := key.String()
			if !fieldPattern.MatchString(name) || name == "__proto__" || name == "constructor" || name == "prototype" {
				return nil, &CardValidationError{Code: CodeCardInvalidPayload, Message: "卡片字段名无效"}
			}
			childValue := value.MapIndex(key)
			if !allowPublicURLs && regexp.MustCompile(`(?i)(callback|webhook|actionurl|targeturl|href|uri|url)$`).MatchString(name) {
				if childValue.Kind() == reflect.String && looksLikeURL(childValue.String()) {
					return nil, &CardValidationError{Code: CodeCardURLForbidden, Message: "卡片不允许未注册的 URL 操作"}
				}
			}
			child, err := visitPayload(childValue, state, limits, allowPublicURLs, path+"."+name, depth+1)
			if err != nil {
				return nil, err
			}
			result[name] = child
		}
		return result, nil
	case reflect.Struct:
		encoded, err := json.Marshal(value.Interface())
		if err != nil {
			return nil, &CardValidationError{Code: CodeCardInvalidPayload, Message: "卡片数据必须是 JSON 值"}
		}
		var decoded any
		if err := json.Unmarshal(encoded, &decoded); err != nil {
			return nil, &CardValidationError{Code: CodeCardInvalidPayload, Message: "卡片数据必须是 JSON 值"}
		}
		return visitPayload(reflect.ValueOf(decoded), state, limits, allowPublicURLs, path, depth)
	default:
		return nil, &CardValidationError{Code: CodeCardInvalidPayload, Message: "卡片数据必须是 JSON 值"}
	}
}

func normalizePayloadString(value string, state *payloadState, limits Limits, allowPublicURLs bool, path string) (string, error) {
	state.textBytes += len([]byte(value))
	if state.textBytes > limits.MaxTextBytes {
		return "", &CardValidationError{Code: CodeCardTextLarge, Message: "卡片文本超限"}
	}
	if htmlPattern.MatchString(value) || scriptPattern.MatchString(value) || eventPattern.MatchString(value) || dynamicCodePattern.MatchString(value) {
		return "", &CardValidationError{Code: CodeCardUnsafeContent, Message: "卡片字段 " + path + " 包含不安全内容"}
	}
	if looksLikeURL(value) {
		if err := assertSafeURL(value, allowPublicURLs); err != nil {
			return "", err
		}
	}
	return value, nil
}

func looksLikeURL(value string) bool { return urlPattern.MatchString(strings.TrimSpace(value)) }

func assertSafeURL(value string, allowPublicURLs bool) error {
	u, err := url.Parse(value)
	if err != nil || u.Scheme == "" && u.Host == "" {
		return &CardValidationError{Code: CodeCardInvalidURL, Message: "卡片 URL 无效"}
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return &CardValidationError{Code: CodeCardURLForbidden, Message: "卡片仅允许 HTTP(S) URL"}
	}
	host := strings.Trim(u.Hostname(), "[]")
	if u.User != nil || net.ParseIP(host) != nil && (net.ParseIP(host).IsLoopback() || net.ParseIP(host).IsPrivate() || net.ParseIP(host).IsLinkLocalUnicast()) || privateHostPattern.MatchString(host) {
		return &CardValidationError{Code: CodeCardPrivateURL, Message: "卡片不允许访问私有地址"}
	}
	if !allowPublicURLs && host != "duallane.invalid" {
		return &CardValidationError{Code: CodeCardURLForbidden, Message: "卡片不允许未注册的 URL 操作"}
	}
	return nil
}

type ValidationResult struct {
	Type         string
	Reason       string
	Block        CardBlock
	FallbackText string
	Definition   *CardDefinition
	Payload      any
}

type Registry struct{ definitions map[string]*CardDefinition }

func NewRegistry(definitions ...CardDefinition) (*Registry, error) {
	r := &Registry{definitions: make(map[string]*CardDefinition)}
	for i := range definitions {
		if _, err := r.Register(definitions[i]); err != nil {
			return nil, err
		}
	}
	return r, nil
}

func (r *Registry) Register(input CardDefinition) (*CardDefinition, error) {
	cardType, err := NormalizeCardType(input.CardType)
	if err != nil {
		return nil, err
	}
	version, err := NormalizeSchemaVersion(input.SchemaVersion)
	if err != nil {
		return nil, err
	}
	if input.Limits == (Limits{}) {
		input.Limits = DefaultLimits
	} else {
		input.Limits = normalizeLimits(input.Limits, DefaultLimits)
	}
	if input.Actions == nil {
		input.Actions = map[string]CardAction{}
	}
	copyDef := input
	copyDef.CardType = cardType
	copyDef.SchemaVersion = version
	copyDef.Actions = make(map[string]CardAction, len(input.Actions))
	for name, action := range input.Actions {
		actionID, err := NormalizeIdentifier(name, CodeCardInvalidAction, "卡片操作 ID 无效")
		if err != nil {
			return nil, err
		}
		if action.Execute == nil {
			return nil, &CardValidationError{Code: CodeCardInvalid, Message: "卡片操作处理器无效"}
		}
		if action.Limits == (Limits{}) {
			action.Limits = Limits{MaxPayloadBytes: MaxActionPayloadBytes, MaxDepth: MaxActionPayloadDepth, MaxNodes: MaxActionPayloadNodes, MaxTextBytes: MaxActionTextBytes}
		} else {
			action.Limits = normalizeLimits(action.Limits, Limits{MaxPayloadBytes: MaxActionPayloadBytes, MaxDepth: MaxActionPayloadDepth, MaxNodes: MaxActionPayloadNodes, MaxTextBytes: MaxActionTextBytes})
		}
		action.ID = actionID
		copyDef.Actions[actionID] = action
	}
	key := registryKey(cardType, version)
	if _, exists := r.definitions[key]; exists {
		return nil, &CardValidationError{Code: "card.duplicate_definition", Message: "卡片定义已注册"}
	}
	r.definitions[key] = &copyDef
	return &copyDef, nil
}

func (r *Registry) Get(cardType string, version int) *CardDefinition {
	if r == nil {
		return nil
	}
	t, err := NormalizeCardType(cardType)
	if err != nil {
		return nil
	}
	v, err := NormalizeSchemaVersion(version)
	if err != nil {
		return nil
	}
	return r.definitions[registryKey(t, v)]
}

func (r *Registry) GetAction(cardType string, version int, actionID string) *CardAction {
	definition := r.Get(cardType, version)
	if definition == nil {
		return nil
	}
	actionID, err := NormalizeIdentifier(actionID, CodeCardInvalidAction, "卡片操作 ID 无效")
	if err != nil {
		return nil
	}
	action, ok := definition.Actions[actionID]
	if !ok {
		return nil
	}
	return &action
}

func (r *Registry) Resolve(block CardBlock) (ValidationResult, error) {
	normalized, err := NormalizeCardBlock(block)
	if err != nil {
		return ValidationResult{}, err
	}
	definition := r.Get(normalized.CardType, normalized.SchemaVersion)
	if definition == nil {
		return ValidationResult{Type: CardFallbackType, Reason: CodeCardUnknownVersion, Block: normalized, FallbackText: normalized.FallbackText}, nil
	}
	return ValidationResult{Type: CardBlockType, Block: normalized, Definition: definition}, nil
}

func (r *Registry) ValidatePayload(block CardBlock, payload any) (ValidationResult, error) {
	if raw, ok := payload.(json.RawMessage); ok {
		return r.ValidatePayloadJSON(block, raw)
	}
	resolved, err := r.Resolve(block)
	if err != nil {
		return ValidationResult{}, err
	}
	if resolved.Definition == nil {
		return resolved, nil
	}
	if resolved.Definition.ValidatePayloadJSON != nil {
		raw, err := json.Marshal(payload)
		if err != nil {
			return ValidationResult{}, invalidJSONPayload()
		}
		return r.ValidatePayloadJSON(block, raw)
	}
	safe, err := NormalizeCardPayload(payload, resolved.Definition.Limits, resolved.Definition.AllowPublicURLs)
	if err != nil {
		return ValidationResult{}, err
	}
	if resolved.Definition.ValidatePayload != nil {
		safe, err = resolved.Definition.ValidatePayload(safe)
		if err != nil {
			return ValidationResult{}, err
		}
	}
	resolved.Payload = safe
	return resolved, nil
}

func (r *Registry) ValidateActionInput(block CardBlock, actionID string, input any) (any, *CardDefinition, *CardAction, error) {
	resolved, err := r.Resolve(block)
	if err != nil {
		return nil, nil, nil, err
	}
	if resolved.Definition == nil {
		return nil, nil, nil, &CardValidationError{Code: CodeCardUnknownVersion, Message: "卡片版本暂不支持"}
	}
	action := r.GetAction(block.CardType, block.SchemaVersion, actionID)
	if action == nil {
		return nil, resolved.Definition, nil, &CardValidationError{Code: CodeCardUnknownAction, Message: "卡片操作暂不支持"}
	}
	safe, err := NormalizeCardPayload(input, action.Limits, false)
	if err != nil {
		return nil, nil, nil, err
	}
	if action.ValidateInput != nil {
		safe, err = action.ValidateInput(safe)
		if err != nil {
			return nil, nil, nil, err
		}
	}
	return safe, resolved.Definition, action, nil
}

func registryKey(cardType string, version int) string { return fmt.Sprintf("%s@%d", cardType, version) }

func (r *Registry) Types() []string {
	if r == nil {
		return []string{}
	}
	result := make([]string, 0, len(r.definitions))
	for _, definition := range r.definitions {
		result = append(result, registryKey(definition.CardType, definition.SchemaVersion))
	}
	sort.Strings(result)
	return result
}
