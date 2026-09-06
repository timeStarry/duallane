package feishucards

import (
	"encoding/json"
)

// ValidateConverted performs the same reconstruction pass as the Node
// validator. Reconstructing the restricted source form is deliberate: it
// keeps one security implementation for both ingress and stored projections.
// Call ValidateConvertedJSON when the caller also needs the checked canonical
// raw representation for hashing or persistence.
func (c *Converter) ValidateConverted(payload any) (Payload, error) {
	raw, err := rawMessage(payload)
	if err != nil {
		return Payload{}, invalidInputError(err)
	}
	result, _, err := c.validateConvertedRaw(raw)
	return result, err
}

// ValidateConvertedJSON validates and reconstructs a converted Feishu card,
// returning both its typed projection and a newly rendered canonical JSON
// representation. The returned bytes are only produced after all domain
// validation succeeds; callers must persist/hash them instead of the input.
func (c *Converter) ValidateConvertedJSON(raw json.RawMessage) (Payload, json.RawMessage, error) {
	return c.validateConvertedRaw(cloneBytes(raw))
}

// ValidatePayloadJSON is the converter-scoped form for callers that already
// own a configured converter and only need the checked canonical bytes.
func (c *Converter) ValidatePayloadJSON(raw json.RawMessage) (json.RawMessage, error) {
	_, canonical, err := c.ValidateConvertedJSON(raw)
	return canonical, err
}

// ValidateConvertedJSON validates a default-limit converted payload and
// returns its typed projection plus the checked canonical raw representation.
func ValidateConvertedJSON(raw json.RawMessage) (Payload, json.RawMessage, error) {
	return ValidateConvertedJSONWithOptions(raw, Options{})
}

// ValidatePayloadJSON is the package-level safe raw validator used by later
// card/gateway composition. It never returns the caller's unvalidated bytes.
func ValidatePayloadJSON(raw json.RawMessage) (json.RawMessage, error) {
	return ValidatePayloadJSONWithOptions(raw, Options{})
}

// ValidatePayloadJSONWithOptions applies the same converter options as
// ConvertJSON while returning only the validated canonical raw payload.
func ValidatePayloadJSONWithOptions(raw json.RawMessage, options Options) (json.RawMessage, error) {
	converter, err := NewConverter(options)
	if err != nil {
		return nil, err
	}
	_, canonical, err := converter.ValidateConvertedJSON(raw)
	return canonical, err
}

// ValidateConvertedJSONWithOptions is the package-level typed-plus-raw
// validator for callers that need the DTO and the canonical bytes together.
func ValidateConvertedJSONWithOptions(raw json.RawMessage, options Options) (Payload, json.RawMessage, error) {
	converter, err := NewConverter(options)
	if err != nil {
		return Payload{}, nil, err
	}
	return converter.ValidateConvertedJSON(raw)
}

func (c *Converter) validateConvertedRaw(raw []byte) (Payload, []byte, error) {
	source, err := parseOrderedJSON(raw)
	if err != nil {
		return Payload{}, nil, invalidInputError(err)
	}
	if source.kind != jsonObject {
		return Payload{}, nil, validationError(CodeInvalid, "飞书卡片映射结果无效")
	}
	format, ok := stringValue(fieldOrNull(source, "format"))
	if !ok || format != PayloadFormat {
		return Payload{}, nil, validationError(CodeInvalid, "飞书卡片映射版本无效")
	}
	config, err := objectValue(fieldOrNull(source, "config"), CodeInvalidConfig, "飞书卡片映射 config 无效")
	if err != nil {
		return Payload{}, nil, err
	}
	header := fieldOrNull(source, "header")
	if header.kind != jsonNull && header.kind != jsonObject {
		return Payload{}, nil, validationError(CodeInvalidHeader, "飞书卡片映射 header 无效")
	}
	elements, err := arrayValue(fieldOrNull(source, "elements"), CodeElementsRequired, "飞书卡片至少需要一个内容元素")
	if err != nil || len(elements) == 0 {
		return Payload{}, nil, validationError(CodeElementsRequired, "飞书卡片至少需要一个内容元素")
	}

	configFields := make([]jsonField, 0, 2)
	if value, exists := config.field("version"); exists {
		configFields = append(configFields, jsonField{key: "version", value: value})
	}
	if value, exists := config.field("wideScreen"); exists {
		configFields = append(configFields, jsonField{key: "wide_screen_mode", value: value})
	}
	reconstructedFields := []jsonField{
		{key: "config", value: makeObject(configFields...)},
	}
	if header.kind == jsonObject {
		reconstructedHeader, err := reconstructHeader(header)
		if err != nil {
			return Payload{}, nil, err
		}
		reconstructedFields = append(reconstructedFields, jsonField{key: "header", value: reconstructedHeader})
	}
	reconstructedElements := make([]orderedValue, len(elements))
	for index, element := range elements {
		reconstructedElements[index], err = reconstructElement(element)
		if err != nil {
			return Payload{}, nil, err
		}
	}
	reconstructedFields = append(reconstructedFields, jsonField{key: "elements", value: makeArray(reconstructedElements...)})
	converted, err := c.convertParsed(makeObject(reconstructedFields...))
	if err != nil {
		return Payload{}, nil, err
	}
	encoded, err := converted.marshalJSON()
	if err != nil {
		return Payload{}, nil, err
	}
	var result Payload
	if err := json.Unmarshal(encoded, &result); err != nil {
		return Payload{}, nil, validationError(CodeInvalidPayload, "卡片映射结果无效")
	}
	return result, json.RawMessage(cloneBytes(encoded)), nil
}

func ValidatePayload(payload any) (any, error) {
	return ValidateConverted(payload)
}

func reconstructHeader(header orderedValue) (orderedValue, error) {
	title := fieldOrNull(header, "title")
	reconstructedTitle := makeObject(
		jsonField{key: "tag", value: makeString("plain_text")},
		jsonField{key: "content", value: title},
	)
	fields := []jsonField{{key: "title", value: reconstructedTitle}}
	if subtitle, exists := header.field("subtitle"); exists && jsTruthy(subtitle) {
		fields = append(fields, jsonField{key: "subtitle", value: makeObject(
			jsonField{key: "tag", value: makeString("plain_text")},
			jsonField{key: "content", value: subtitle},
		)})
	}
	if tone, exists := header.field("tone"); exists && jsTruthy(tone) {
		if value, ok := stringValue(tone); ok && value != "neutral" {
			template, err := reverseToneValue(value)
			if err != nil {
				return orderedValue{}, err
			}
			fields = append(fields, jsonField{key: "template", value: makeString(template)})
		}
	}
	return makeObject(fields...), nil
}

func reconstructElement(value orderedValue) (orderedValue, error) {
	element, err := objectValue(value, CodeInvalidElement, "飞书卡片映射元素无效")
	if err != nil {
		return orderedValue{}, err
	}
	typeValue, ok := stringValue(fieldOrNull(element, "type"))
	if !ok {
		return orderedValue{}, validationError(CodeUnknownElement, "飞书卡片包含不支持的元素")
	}
	switch typeValue {
	case "text":
		text := fieldOrNull(element, "text")
		if format, ok := stringValue(fieldOrNull(element, "format")); ok && format == "markdown" {
			return makeObject(jsonField{key: "tag", value: makeString("markdown")}, jsonField{key: "content", value: text}), nil
		}
		return makeObject(
			jsonField{key: "tag", value: makeString("div")},
			jsonField{key: "text", value: makeObject(
				jsonField{key: "tag", value: makeString("plain_text")},
				jsonField{key: "content", value: text},
			)},
		), nil
	case "note":
		parts, err := arrayValue(fieldOrNull(element, "parts"), CodeInvalidNote, "飞书卡片 note 映射无效")
		if err != nil {
			return orderedValue{}, err
		}
		reconstructed := make([]orderedValue, len(parts))
		for index, partValue := range parts {
			part, partErr := objectValue(partValue, CodeInvalidNote, "飞书卡片 note 映射无效")
			if partErr != nil {
				return orderedValue{}, partErr
			}
			tag := "plain_text"
			if format, ok := stringValue(fieldOrNull(part, "format")); ok && format == "markdown" {
				tag = "lark_md"
			}
			reconstructed[index] = makeObject(
				jsonField{key: "tag", value: makeString(tag)},
				jsonField{key: "content", value: fieldOrNull(part, "text")},
			)
		}
		return makeObject(jsonField{key: "tag", value: makeString("note")}, jsonField{key: "elements", value: makeArray(reconstructed...)}), nil
	case "divider":
		return makeObject(jsonField{key: "tag", value: makeString("hr")}), nil
	case "actions":
		buttons, err := arrayValue(fieldOrNull(element, "buttons"), CodeInvalidActions, "飞书卡片按钮映射无效")
		if err != nil {
			return orderedValue{}, err
		}
		reconstructed := make([]orderedValue, len(buttons))
		for index, buttonValue := range buttons {
			button, buttonErr := objectValue(buttonValue, CodeInvalidButton, "飞书卡片按钮映射无效")
			if buttonErr != nil {
				return orderedValue{}, buttonErr
			}
			valueFields := []jsonField{
				{key: "action_id", value: fieldOrNull(button, "actionId")},
			}
			if data, exists := button.field("data"); exists {
				valueFields = append(valueFields, jsonField{key: "data", value: data})
			}
			reconstructed[index] = makeObject(
				jsonField{key: "tag", value: makeString("button")},
				jsonField{key: "text", value: makeObject(
					jsonField{key: "tag", value: makeString("plain_text")},
					jsonField{key: "content", value: fieldOrNull(button, "label")},
				)},
				jsonField{key: "type", value: fieldOrNull(button, "style")},
				jsonField{key: "value", value: makeObject(valueFields...)},
			)
		}
		return makeObject(jsonField{key: "tag", value: makeString("action")}, jsonField{key: "actions", value: makeArray(reconstructed...)}), nil
	case "columns":
		columns, err := arrayValue(fieldOrNull(element, "columns"), CodeInvalidColumns, "飞书卡片 columns 映射无效")
		if err != nil {
			return orderedValue{}, err
		}
		reconstructed := make([]orderedValue, len(columns))
		for index, columnValue := range columns {
			column, columnErr := objectValue(columnValue, CodeInvalidColumn, "飞书卡片列映射无效")
			if columnErr != nil {
				return orderedValue{}, columnErr
			}
			fields := []jsonField{{key: "tag", value: makeString("column")}, {key: "width", value: fieldOrNull(column, "width")}}
			if weight, exists := column.field("weight"); exists && jsTruthy(weight) {
				fields = append(fields, jsonField{key: "weight", value: weight})
			}
			children, childrenErr := arrayValue(fieldOrNull(column, "elements"), CodeInvalidColumn, "飞书卡片列映射无效")
			if childrenErr != nil {
				return orderedValue{}, childrenErr
			}
			reconstructedChildren := make([]orderedValue, len(children))
			for childIndex, child := range children {
				reconstructedChildren[childIndex], err = reconstructElement(child)
				if err != nil {
					return orderedValue{}, err
				}
			}
			fields = append(fields, jsonField{key: "elements", value: makeArray(reconstructedChildren...)})
			reconstructed[index] = makeObject(fields...)
		}
		return makeObject(jsonField{key: "tag", value: makeString("column_set")}, jsonField{key: "columns", value: makeArray(reconstructed...)}), nil
	default:
		return orderedValue{}, validationError(CodeUnknownElement, "飞书卡片包含不支持的元素")
	}
}

func reverseToneValue(value string) (string, error) {
	for template, tone := range headerTones {
		if tone == value {
			return template, nil
		}
	}
	return "", validationError(CodeStyleForbidden, "飞书卡片 header 样式不在允许列表中")
}

func jsTruthy(value orderedValue) bool {
	switch value.kind {
	case jsonNull:
		return false
	case jsonBool:
		return value.bool
	case jsonNumber:
		return value.number != 0
	case jsonString:
		return value.string != ""
	case jsonArray, jsonObject:
		return true
	default:
		return false
	}
}
