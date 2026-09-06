package botgateway

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sort"
)

// These are deliberately operation-specific envelopes. Their field order and
// null behavior mirror the Node gateway's withIdempotency input objects; this
// is not a general-purpose JSON canonicalizer for arbitrary caller objects.
type messageIdempotencyInput struct {
	ConversationID   string         `json:"conversationId"`
	ClientMessageID  string         `json:"clientMessageId"`
	ReplyToMessageID *string        `json:"replyToMessageId"`
	Content          MessageContent `json:"content"`
}

type cardIdempotencyInput struct {
	ConversationID string          `json:"conversationId"`
	CardType       string          `json:"cardType"`
	SchemaVersion  int             `json:"schemaVersion"`
	FallbackText   string          `json:"fallbackText"`
	Payload        any             `json:"payload"`
	RawPayload     json.RawMessage `json:"-"`
}

type nodeRawJSON []byte

func (value nodeRawJSON) MarshalJSON() ([]byte, error) {
	if len(value) == 0 {
		return []byte("null"), nil
	}
	return value, nil
}

type nodeField struct {
	key   string
	value any
}

func (value messageIdempotencyInput) MarshalJSON() ([]byte, error) {
	content, err := marshalMessageContent(value.Content)
	if err != nil {
		return nil, err
	}
	return marshalNodeObject(
		nodeField{key: "conversationId", value: value.ConversationID},
		nodeField{key: "clientMessageId", value: value.ClientMessageID},
		nodeField{key: "replyToMessageId", value: value.ReplyToMessageID},
		nodeField{key: "content", value: nodeRawJSON(content)},
	)
}

func (value cardIdempotencyInput) MarshalJSON() ([]byte, error) {
	payload, err := nodeJSONMarshal(value.Payload)
	if len(value.RawPayload) > 0 {
		payload, err = nodeParsedJSON(value.RawPayload)
	}
	if err != nil {
		return nil, err
	}
	return marshalNodeObject(
		nodeField{key: "conversationId", value: value.ConversationID},
		nodeField{key: "cardType", value: value.CardType},
		nodeField{key: "schemaVersion", value: value.SchemaVersion},
		nodeField{key: "fallbackText", value: value.FallbackText},
		nodeField{key: "payload", value: nodeRawJSON(payload)},
	)
}

func marshalMessageContent(value MessageContent) ([]byte, error) {
	var plainText any = value.PlainText
	if len(value.hashPlainText) > 0 {
		plainText = nodeRawJSON(value.hashPlainText)
	}
	if len(value.hashBlocks) > 0 {
		return marshalNodeObject(
			nodeField{key: "format", value: value.Format},
			nodeField{key: "plainText", value: plainText},
			nodeField{key: "blocks", value: nodeRawJSON(value.hashBlocks)},
		)
	}
	blocks := bytes.NewBufferString("[")
	for index, block := range value.Blocks {
		if index > 0 {
			blocks.WriteByte(',')
		}
		encoded, err := marshalMessageBlock(block)
		if err != nil {
			return nil, err
		}
		blocks.Write(encoded)
	}
	blocks.WriteByte(']')
	return marshalNodeObject(
		nodeField{key: "format", value: value.Format},
		nodeField{key: "plainText", value: plainText},
		nodeField{key: "blocks", value: nodeRawJSON(blocks.Bytes())},
	)
}

func marshalMessageBlock(value map[string]any) ([]byte, error) {
	order := []string{"type"}
	switch blockType, _ := value["type"].(string); blockType {
	case "text":
		order = append(order, "text")
	case "mention":
		order = append(order, "userId", "label")
	case "link":
		order = append(order, "url", "label")
	case "emoji":
		order = append(order, "shortcode")
	case "emote_collection":
		order = append(order, "shareId")
	case "topic_reference":
		order = append(order, "topicId", "title")
	case "attachment":
		order = append(order, "attachmentId")
	case "card":
		order = append(order, "cardId", "cardType", "schemaVersion", "fallbackText")
	default:
		order = nil
	}
	seen := make(map[string]struct{}, len(order))
	fields := make([]nodeField, 0, len(value))
	for _, key := range order {
		if raw, ok := value[key]; ok {
			fields = append(fields, nodeField{key: key, value: raw})
			seen[key] = struct{}{}
		}
	}
	unknown := make([]string, 0, len(value)-len(fields))
	for key := range value {
		if _, ok := seen[key]; !ok {
			unknown = append(unknown, key)
		}
	}
	sort.Strings(unknown)
	for _, key := range unknown {
		fields = append(fields, nodeField{key: key, value: value[key]})
	}
	return marshalNodeObject(fields...)
}

func marshalNodeObject(fields ...nodeField) ([]byte, error) {
	buffer := bytes.NewBuffer(make([]byte, 0, len(fields)*16+2))
	buffer.WriteByte('{')
	for index, field := range fields {
		if index > 0 {
			buffer.WriteByte(',')
		}
		key, err := nodeJSONMarshal(field.key)
		if err != nil {
			return nil, err
		}
		value, err := nodeJSONMarshal(field.value)
		if err != nil {
			return nil, err
		}
		buffer.Write(key)
		buffer.WriteByte(':')
		buffer.Write(value)
	}
	buffer.WriteByte('}')
	return buffer.Bytes(), nil
}

func hashGatewayRequest(value any) (string, error) {
	encoded, err := nodeJSONMarshal(value)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:]), nil
}

// nodeJSONMarshal keeps Go's safe JSON behavior while matching JSON.stringify
// for the values accepted by the gateway: HTML punctuation and U+2028/U+2029
// remain literal, while control characters, quotes, and backslashes retain
// JSON escaping. encoding/json sorts keys of maps because Go has no map
// insertion order; callers therefore pass the fixed operation envelopes above
// and must not treat this helper as a cross-language arbitrary-object
// canonicalizer.
func nodeJSONMarshal(value any) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	encoded := bytes.TrimSuffix(buffer.Bytes(), []byte{'\n'})
	if len(encoded) == 0 {
		return nil, errors.New("gateway request JSON is empty")
	}
	compatible := make([]byte, 0, len(encoded))
	for index := 0; index < len(encoded); index++ {
		if encoded[index] == '\\' && index+1 < len(encoded) && encoded[index+1] == '\\' {
			compatible = append(compatible, encoded[index], encoded[index+1])
			index++
			continue
		}
		if encoded[index] == '\\' && index+5 < len(encoded) && encoded[index+1] == 'u' {
			digit := encoded[index+2 : index+6]
			switch string(digit) {
			case "2028":
				compatible = append(compatible, 0xe2, 0x80, 0xa8)
				index += 5
				continue
			case "2029":
				compatible = append(compatible, 0xe2, 0x80, 0xa9)
				index += 5
				continue
			}
		}
		compatible = append(compatible, encoded[index])
	}
	return compatible, nil
}
