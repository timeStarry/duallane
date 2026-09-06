package botgateway

import (
	"bytes"
	"encoding/json"
)

func normalizeBotInputContent(input SendMessageInput) (MessageContent, error) {
	raw := bytes.TrimSpace(input.RawContent)
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		raw = bytes.TrimSpace(input.RawText)
	}
	if len(raw) == 0 {
		return normalizeBotContent(input.Content, input.Text)
	}
	var value any
	if !json.Valid(raw) || json.Unmarshal(raw, &value) != nil {
		return MessageContent{}, NewError(CodeMessageInvalid, MessageMessageInvalid, 400)
	}
	content, err := normalizeBotContent(value, "")
	if err != nil {
		return MessageContent{}, err
	}
	if _, ok := value.(string); ok {
		content.hashPlainText, err = nodeTrimmedJSONString(raw)
		if err != nil {
			return MessageContent{}, NewError(CodeMessageInvalid, MessageMessageInvalid, 400)
		}
		block, err := marshalNodeObject(nodeField{key: "type", value: "text"}, nodeField{key: "text", value: nodeRawJSON(content.hashPlainText)})
		if err != nil {
			return MessageContent{}, err
		}
		content.hashBlocks = append(append([]byte{'['}, block...), ']')
		return content, nil
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return MessageContent{}, NewError(CodeMessageInvalid, MessageMessageInvalid, 400)
	}
	content.hashBlocks, err = nodeParsedJSON(fields["blocks"])
	if err != nil {
		return MessageContent{}, NewError(CodeMessageInvalid, MessageMessageInvalid, 400)
	}
	content.hashPlainText, err = nodeTrimmedJSONString(fields["plainText"])
	if err != nil {
		return MessageContent{}, NewError(CodeMessageInvalid, MessageMessageInvalid, 400)
	}
	return content, nil
}
