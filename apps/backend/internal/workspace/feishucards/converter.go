package feishucards

import (
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf16"
)

type Converter struct {
	limits         Limits
	allowedActions map[string]struct{}
}

func NewConverter(options Options) (*Converter, error) {
	limits := normalizeLimits(options.Limits, DefaultLimits)
	allowed, err := normalizeAllowedActions(options.AllowedActions)
	if err != nil {
		return nil, err
	}
	return &Converter{limits: limits, allowedActions: allowed}, nil
}

func Convert(input any) (Result, error) {
	return ConvertWithOptions(input, Options{})
}

func ConvertWithOptions(input any, options Options) (Result, error) {
	converter, err := NewConverter(options)
	if err != nil {
		return Result{}, err
	}
	return converter.Convert(input)
}

func ConvertJSON(raw []byte) (Result, error) {
	return ConvertJSONWithOptions(raw, Options{})
}

func ConvertJSONWithOptions(raw []byte, options Options) (Result, error) {
	converter, err := NewConverter(options)
	if err != nil {
		return Result{}, err
	}
	return converter.convertRaw(raw)
}

func ValidateConverted(payload any) (Payload, error) {
	return ValidateConvertedWithOptions(payload, Options{})
}

func ValidateConvertedWithOptions(payload any, options Options) (Payload, error) {
	converter, err := NewConverter(options)
	if err != nil {
		return Payload{}, err
	}
	return converter.ValidateConverted(payload)
}

func (c *Converter) Convert(input any) (Result, error) {
	raw, err := rawMessage(input)
	if err != nil {
		return Result{}, invalidInputError(err)
	}
	return c.convertRaw(raw)
}

func (c *Converter) ConvertJSON(raw []byte) (Result, error) {
	return c.convertRaw(raw)
}

func (c *Converter) convertRaw(raw []byte) (Result, error) {
	if c == nil {
		return Result{}, validationError(CodeInvalidDefinition, "飞书卡片转换器无效")
	}
	source, err := parseOrderedJSON(raw)
	if err != nil {
		return Result{}, invalidInputError(err)
	}
	converted, err := c.convertParsed(source)
	if err != nil {
		return Result{}, err
	}
	encoded, err := converted.marshalJSON()
	if err != nil {
		return Result{}, err
	}
	var typed Payload
	if err := json.Unmarshal(encoded, &typed); err != nil {
		return Result{}, validationError(CodeInvalidPayload, "卡片映射结果无效")
	}
	fallbackUnits := deriveFallbackUnits(converted)
	fallback := string(utf16.Decode(fallbackUnits))
	canonicalFallbackJSON, err := marshalNodeStringUnits(fallbackUnits, fallback)
	if err != nil {
		return Result{}, err
	}
	return Result{
		CardType:              CardType,
		SchemaVersion:         SchemaVersion,
		Payload:               typed,
		FallbackText:          fallback,
		PayloadJSON:           cloneBytes(encoded),
		HashJSON:              cloneBytes(encoded),
		CanonicalFallbackJSON: cloneBytes(canonicalFallbackJSON),
	}, nil
}

func (c *Converter) convertParsed(source orderedValue) (orderedValue, error) {
	if source.kind != jsonObject {
		return orderedValue{}, validationError(CodeInvalid, "飞书卡片必须是 JSON 对象")
	}
	if err := assertKnownKeys(source, map[string]struct{}{"config": {}, "elements": {}, "header": {}}, "卡片"); err != nil {
		return orderedValue{}, err
	}
	elementsValue, ok := source.field("elements")
	if !ok || elementsValue.kind != jsonArray || len(elementsValue.array) == 0 {
		return orderedValue{}, validationError(CodeElementsRequired, "飞书卡片至少需要一个内容元素")
	}
	state := &convertState{limits: c.limits, allowedActions: c.allowedActions, seenActions: make(map[string]struct{})}
	config, err := c.convertConfig(source, state)
	if err != nil {
		return orderedValue{}, err
	}
	header, err := c.convertHeader(source, state)
	if err != nil {
		return orderedValue{}, err
	}
	convertedElements := make([]orderedValue, len(elementsValue.array))
	for index, element := range elementsValue.array {
		convertedElements[index], err = c.convertElement(element, state, 1)
		if err != nil {
			return orderedValue{}, err
		}
	}
	payload := makeObject(
		jsonField{key: "format", value: makeString(PayloadFormat)},
		jsonField{key: "config", value: config},
		jsonField{key: "header", value: header},
		jsonField{key: "elements", value: makeArray(convertedElements...)},
	)
	return normalizePayload(payload, c.limits, true)
}

func (c *Converter) convertConfig(source orderedValue, state *convertState) (orderedValue, error) {
	value, ok := source.field("config")
	if !ok {
		return makeObject(
			jsonField{key: "version", value: makeString("1.0")},
			jsonField{key: "wideScreen", value: makeBool(false)},
		), nil
	}
	config, err := objectValue(value, CodeInvalidConfig, "飞书卡片 config 无效")
	if err != nil {
		return orderedValue{}, err
	}
	if err := assertKnownKeys(config, map[string]struct{}{"version": {}, "wide_screen_mode": {}}, "config"); err != nil {
		return orderedValue{}, err
	}
	if version, exists := config.field("version"); exists {
		value, ok := stringValue(version)
		if !ok || value != "1.0" {
			return orderedValue{}, validationError(CodeUnsupportedVersion, "仅支持飞书卡片 1.0 子集")
		}
	}
	wideScreen := false
	if value, exists := config.field("wide_screen_mode"); exists {
		parsed, ok := boolValue(value)
		if !ok {
			return orderedValue{}, validationError(CodeInvalidConfig, "wide_screen_mode 必须是布尔值")
		}
		wideScreen = parsed
	}
	if err := state.count(1); err != nil {
		return orderedValue{}, err
	}
	return makeObject(
		jsonField{key: "version", value: makeString("1.0")},
		jsonField{key: "wideScreen", value: makeBool(wideScreen)},
	), nil
}

func (c *Converter) convertHeader(source orderedValue, state *convertState) (orderedValue, error) {
	value, ok := source.field("header")
	if !ok {
		return orderedValue{kind: jsonNull}, nil
	}
	header, err := objectValue(value, CodeInvalidHeader, "飞书卡片 header 无效")
	if err != nil {
		return orderedValue{}, err
	}
	if err := assertKnownKeys(header, map[string]struct{}{"subtitle": {}, "template": {}, "title": {}}, "header"); err != nil {
		return orderedValue{}, err
	}
	titleValue, _ := header.field("title")
	title, err := c.convertTextObject(titleValue, state, false, true)
	if err != nil {
		return orderedValue{}, err
	}
	fields := []jsonField{{key: "title", value: title.orderedValue()}}
	if subtitleValue, exists := header.field("subtitle"); exists {
		subtitle, subtitleErr := c.convertTextObject(subtitleValue, state, false, true)
		if subtitleErr != nil {
			return orderedValue{}, subtitleErr
		}
		if subtitle.text != "" {
			fields = append(fields, jsonField{key: "subtitle", value: subtitle.orderedValue()})
		}
	}
	tone := "neutral"
	if templateValue, exists := header.field("template"); exists {
		template, ok := stringValue(templateValue)
		mapped, known := headerTones[template]
		if !ok || !known {
			return orderedValue{}, validationError(CodeStyleForbidden, "飞书卡片 header 样式不在允许列表中")
		}
		tone = mapped
	}
	if err := state.count(1); err != nil {
		return orderedValue{}, err
	}
	fields = append(fields, jsonField{key: "tone", value: makeString(tone)})
	return makeObject(fields...), nil
}

func (c *Converter) convertElement(value orderedValue, state *convertState, depth int) (orderedValue, error) {
	if err := state.count(depth); err != nil {
		return orderedValue{}, err
	}
	element, err := objectValue(value, CodeInvalidElement, "飞书卡片元素无效")
	if err != nil {
		return orderedValue{}, err
	}
	tagValue, _ := element.field("tag")
	tag, _ := stringValue(tagValue)
	switch tag {
	case "div":
		if err := assertKnownKeys(element, map[string]struct{}{"tag": {}, "text": {}}, "div"); err != nil {
			return orderedValue{}, err
		}
		text, err := c.convertTextObject(fieldOrNull(element, "text"), state, true, true)
		if err != nil {
			return orderedValue{}, err
		}
		return makeObject(
			jsonField{key: "type", value: makeString("text")},
			jsonField{key: "format", value: makeString(text.format)},
			jsonField{key: "text", value: text.orderedValue()},
		), nil
	case "markdown":
		if err := assertKnownKeys(element, map[string]struct{}{"content": {}, "tag": {}}, "markdown"); err != nil {
			return orderedValue{}, err
		}
		text, err := c.normalizeText(fieldOrNull(element, "content"), state)
		if err != nil {
			return orderedValue{}, err
		}
		return makeObject(
			jsonField{key: "type", value: makeString("text")},
			jsonField{key: "format", value: makeString("markdown")},
			jsonField{key: "text", value: text.orderedValue()},
		), nil
	case "note":
		if err := assertKnownKeys(element, map[string]struct{}{"elements": {}, "tag": {}}, "note"); err != nil {
			return orderedValue{}, err
		}
		partsValue, err := arrayValue(fieldOrNull(element, "elements"), CodeInvalidNote, "飞书卡片 note 元素数量无效")
		if err != nil || len(partsValue) == 0 || len(partsValue) > 8 {
			return orderedValue{}, validationError(CodeInvalidNote, "飞书卡片 note 元素数量无效")
		}
		parts := make([]orderedValue, len(partsValue))
		for index, part := range partsValue {
			converted, partErr := c.convertTextObject(part, state, true, true)
			if partErr != nil {
				return orderedValue{}, partErr
			}
			parts[index] = makeObject(
				jsonField{key: "format", value: makeString(converted.format)},
				jsonField{key: "text", value: converted.orderedValue()},
			)
		}
		return makeObject(jsonField{key: "type", value: makeString("note")}, jsonField{key: "parts", value: makeArray(parts...)}), nil
	case "hr":
		if err := assertKnownKeys(element, map[string]struct{}{"tag": {}}, "hr"); err != nil {
			return orderedValue{}, err
		}
		return makeObject(jsonField{key: "type", value: makeString("divider")}), nil
	case "action":
		if err := assertKnownKeys(element, map[string]struct{}{"actions": {}, "tag": {}}, "action"); err != nil {
			return orderedValue{}, err
		}
		return c.convertActions(fieldOrNull(element, "actions"), state, depth+1)
	case "button_list":
		if err := assertKnownKeys(element, map[string]struct{}{"buttons": {}, "tag": {}}, "button_list"); err != nil {
			return orderedValue{}, err
		}
		return c.convertActions(fieldOrNull(element, "buttons"), state, depth+1)
	case "column_set", "columns":
		return c.convertColumns(element, state, depth+1)
	default:
		return orderedValue{}, validationError(CodeUnknownElement, "飞书卡片包含不支持的元素")
	}
}

func (c *Converter) convertActions(value orderedValue, state *convertState, depth int) (orderedValue, error) {
	actions, err := arrayValue(value, CodeInvalidActions, "飞书卡片按钮数量无效")
	if err != nil || len(actions) == 0 || len(actions) > 6 {
		return orderedValue{}, validationError(CodeInvalidActions, "飞书卡片按钮数量无效")
	}
	buttons := make([]orderedValue, len(actions))
	for index, button := range actions {
		converted, buttonErr := c.convertButton(button, state, depth)
		if buttonErr != nil {
			return orderedValue{}, buttonErr
		}
		buttons[index] = converted
	}
	return makeObject(jsonField{key: "type", value: makeString("actions")}, jsonField{key: "buttons", value: makeArray(buttons...)}), nil
}

func (c *Converter) convertButton(value orderedValue, state *convertState, depth int) (orderedValue, error) {
	if err := state.count(depth); err != nil {
		return orderedValue{}, err
	}
	button, err := objectValue(value, CodeInvalidButton, "飞书卡片按钮无效")
	if err != nil {
		return orderedValue{}, err
	}
	if err := assertKnownKeys(button, map[string]struct{}{"action_id": {}, "tag": {}, "text": {}, "type": {}, "value": {}}, "button"); err != nil {
		return orderedValue{}, err
	}
	if tag, _ := stringValue(fieldOrNull(button, "tag")); tag != "button" {
		return orderedValue{}, validationError(CodeInvalidButton, "action 中仅允许 button")
	}
	valueObject := makeObject()
	if inputValue, exists := button.field("value"); exists {
		valueObject, err = objectValue(inputValue, CodeInvalidAction, "按钮 value 无效")
		if err != nil {
			return orderedValue{}, err
		}
	}
	if err := assertKnownKeys(valueObject, map[string]struct{}{"action_id": {}, "data": {}}, "button.value"); err != nil {
		return orderedValue{}, err
	}
	actionValue, actionExists := button.field("action_id")
	if !actionExists || actionValue.kind == jsonNull {
		actionValue, _ = valueObject.field("action_id")
	}
	actionID, err := normalizeActionID(actionValue, c.allowedActions)
	if err != nil {
		return orderedValue{}, err
	}
	if _, exists := state.seenActions[actionID]; exists {
		return orderedValue{}, validationError(CodeDuplicateAction, "飞书卡片动作标识必须唯一")
	}
	state.seenActions[actionID] = struct{}{}
	label := normalizedText{}
	textValue := fieldOrNull(button, "text")
	if textValue.kind == jsonString {
		label, err = c.normalizeText(textValue, state)
	} else {
		converted, textErr := c.convertTextObject(textValue, state, false, true)
		if textErr == nil {
			label = normalizedText{text: converted.text, units: cloneUnits(converted.units)}
		}
		err = textErr
	}
	if err != nil {
		return orderedValue{}, err
	}
	style := "default"
	if styleValue, exists := button.field("type"); exists && styleValue.kind != jsonNull {
		style, _ = stringValue(styleValue)
	}
	if style != "default" && style != "primary" && style != "danger" {
		return orderedValue{}, validationError(CodeStyleForbidden, "按钮样式不在允许列表中")
	}
	data := makeObject()
	if dataValue, exists := valueObject.field("data"); exists {
		data, err = normalizePayload(dataValue, ActionLimits, false)
		if err != nil {
			return orderedValue{}, err
		}
	}
	return makeObject(
		jsonField{key: "type", value: makeString("button")},
		jsonField{key: "label", value: label.orderedValue()},
		jsonField{key: "actionId", value: makeString(actionID)},
		jsonField{key: "style", value: makeString(style)},
		jsonField{key: "data", value: data},
	), nil
}

func (c *Converter) convertColumns(value orderedValue, state *convertState, depth int) (orderedValue, error) {
	element, err := objectValue(value, CodeInvalidColumns, "飞书卡片 columns 无效")
	if err != nil {
		return orderedValue{}, err
	}
	if err := assertKnownKeys(element, map[string]struct{}{"columns": {}, "tag": {}}, "columns"); err != nil {
		return orderedValue{}, err
	}
	columns, err := arrayValue(fieldOrNull(element, "columns"), CodeInvalidColumns, "飞书卡片列数必须为 2 至 4")
	if err != nil || len(columns) < 2 || len(columns) > 4 {
		return orderedValue{}, validationError(CodeInvalidColumns, "飞书卡片列数必须为 2 至 4")
	}
	convertedColumns := make([]orderedValue, len(columns))
	for index, columnValue := range columns {
		if err := state.count(depth); err != nil {
			return orderedValue{}, err
		}
		column, columnErr := objectValue(columnValue, CodeInvalidColumn, "飞书卡片列无效")
		if columnErr != nil {
			return orderedValue{}, columnErr
		}
		if tag, exists := column.field("tag"); exists {
			if parsed, ok := stringValue(tag); !ok || parsed != "column" {
				return orderedValue{}, validationError(CodeInvalidColumn, "columns 中仅允许 column")
			}
		}
		if err := assertKnownKeys(column, map[string]struct{}{"elements": {}, "tag": {}, "weight": {}, "width": {}}, "column"); err != nil {
			return orderedValue{}, err
		}
		width := "weighted"
		if widthValue, exists := column.field("width"); exists && widthValue.kind != jsonNull {
			width, _ = stringValue(widthValue)
		}
		if width != "auto" && width != "weighted" {
			return orderedValue{}, validationError(CodeStyleForbidden, "列宽样式不在允许列表中")
		}
		fields := []jsonField{{key: "width", value: makeString(width)}}
		if width == "weighted" {
			weight, weightErr := columnWeight(fieldOrNull(column, "weight"))
			if weightErr != nil {
				return orderedValue{}, weightErr
			}
			fields = append(fields, jsonField{key: "weight", value: makeNumber(float64(weight))})
		}
		children, childrenErr := arrayValue(fieldOrNull(column, "elements"), CodeInvalidColumn, "列内容数量无效")
		if childrenErr != nil || len(children) == 0 || len(children) > 8 {
			return orderedValue{}, validationError(CodeInvalidColumn, "列内容数量无效")
		}
		convertedChildren := make([]orderedValue, len(children))
		for childIndex, child := range children {
			convertedChildren[childIndex], err = c.convertElement(child, state, depth+1)
			if err != nil {
				return orderedValue{}, err
			}
		}
		fields = append(fields, jsonField{key: "elements", value: makeArray(convertedChildren...)})
		convertedColumns[index] = makeObject(fields...)
	}
	return makeObject(jsonField{key: "type", value: makeString("columns")}, jsonField{key: "columns", value: makeArray(convertedColumns...)}), nil
}

type convertedText struct {
	format string
	text   string
	units  []uint16
}

func (value convertedText) orderedValue() orderedValue {
	return makeStringUnits(value.units, value.text)
}

func (c *Converter) convertTextObject(value orderedValue, state *convertState, allowMarkdown, required bool) (convertedText, error) {
	text, err := objectValue(value, CodeInvalidText, "飞书卡片文本无效")
	if err != nil {
		return convertedText{}, err
	}
	if err := assertKnownKeys(text, map[string]struct{}{"content": {}, "tag": {}}, "text"); err != nil {
		return convertedText{}, err
	}
	tag, ok := stringValue(fieldOrNull(text, "tag"))
	allowed := tag == "plain_text" || allowMarkdown && tag == "lark_md"
	if !ok || !allowed {
		return convertedText{}, validationError(CodeInvalidText, "飞书卡片文本格式不受支持")
	}
	content, err := c.normalizeText(fieldOrNull(text, "content"), state)
	if err != nil {
		return convertedText{}, err
	}
	if required && content.text == "" {
		return convertedText{}, validationError(CodeInvalidText, "飞书卡片文本不能为空")
	}
	format := "plain"
	if tag == "lark_md" {
		format = "markdown"
	}
	return convertedText{format: format, text: content.text, units: cloneUnits(content.units)}, nil
}

func (c *Converter) normalizeText(value orderedValue, state *convertState) (normalizedText, error) {
	return normalizeText(value, state)
}

func normalizeActionID(value orderedValue, allowed map[string]struct{}) (string, error) {
	action, ok := stringValue(value)
	action = strings.ToLower(nodeTrimSpace(action))
	if !ok || !actionIDPattern.MatchString(action) {
		return "", validationError(CodeUnknownAction, "飞书卡片动作未注册")
	}
	if _, exists := allowed[action]; !exists {
		return "", validationError(CodeUnknownAction, "飞书卡片动作未注册")
	}
	return action, nil
}

func normalizeAllowedActions(value []string) (map[string]struct{}, error) {
	if value == nil {
		value = append([]string(nil), ActionIDs[:]...)
	}
	result := make(map[string]struct{}, len(value))
	for _, action := range value {
		normalized := strings.ToLower(nodeTrimSpace(action))
		if !actionIDPattern.MatchString(normalized) || !isRegisteredAction(normalized) {
			return nil, validationError(CodeUnknownAction, "飞书卡片动作未注册")
		}
		result[normalized] = struct{}{}
	}
	return result, nil
}

func isRegisteredAction(value string) bool {
	for _, action := range ActionIDs {
		if action == value {
			return true
		}
	}
	return false
}

func fieldOrNull(value orderedValue, key string) orderedValue {
	if result, ok := value.field(key); ok {
		return result
	}
	return orderedValue{kind: jsonNull}
}

func assertKnownKeys(value orderedValue, allowed map[string]struct{}, label string) error {
	for _, field := range value.object {
		if _, ok := allowed[field.key]; !ok {
			return validationError("card.feishu_unknown_field", label+" 包含不支持的字段")
		}
	}
	return nil
}

type convertState struct {
	nodes          int
	textBytes      int
	limits         Limits
	allowedActions map[string]struct{}
	seenActions    map[string]struct{}
}

func (state *convertState) count(depth int) error {
	if depth > state.limits.MaxDepth {
		return validationError(CodePayloadTooDeep, "卡片嵌套深度超限")
	}
	state.nodes++
	if state.nodes > state.limits.MaxNodes {
		return validationError(CodePayloadTooComplex, "卡片节点数量超限")
	}
	return nil
}

func columnWeight(value orderedValue) (int, error) {
	number := 1.0
	if value.kind != jsonNull {
		switch value.kind {
		case jsonNumber:
			number = value.number
		case jsonBool:
			if value.bool {
				number = 1
			} else {
				number = 0
			}
		case jsonString:
			parsed, err := strconv.ParseFloat(nodeTrimSpace(value.string), 64)
			if err != nil {
				number = 0
			} else {
				number = parsed
			}
		default:
			number = 0
		}
	}
	if number < 1 || number > 12 || number != float64(int(number)) || number > 9_007_199_254_740_991 {
		return 0, validationError(CodeInvalidColumn, "列权重无效")
	}
	return int(number), nil
}

var (
	actionIDPattern = regexp.MustCompile(`^[a-z][a-z0-9._-]{0,63}$`)
	headerTones     = map[string]string{"blue": "info", "green": "success", "orange": "warning", "red": "danger", "grey": "neutral", "gray": "neutral"}
)

func deriveFallbackUnits(payload orderedValue) []uint16 {
	candidates := make([]string, 0, 1+len(payload.array))
	candidateUnits := make([][]uint16, 0, 1+len(payload.array))
	if header, ok := payload.field("header"); ok && header.kind == jsonObject {
		if title, ok := header.field("title"); ok {
			if value, ok := stringValue(title); ok {
				candidates = append(candidates, value)
				candidateUnits = append(candidateUnits, valueUnits(title))
			}
		}
	}
	if elements, ok := payload.field("elements"); ok && elements.kind == jsonArray {
		for _, element := range elements.array {
			typeValue, _ := stringValue(fieldOrNull(element, "type"))
			switch typeValue {
			case "text":
				textValue := fieldOrNull(element, "text")
				if text, ok := stringValue(textValue); ok {
					candidates = append(candidates, text)
					candidateUnits = append(candidateUnits, valueUnits(textValue))
				}
			case "note":
				parts := fieldOrNull(element, "parts")
				if parts.kind == jsonArray {
					values := make([]string, 0, len(parts.array))
					units := make([]uint16, 0)
					for _, part := range parts.array {
						textValue := fieldOrNull(part, "text")
						if text, ok := stringValue(textValue); ok {
							if len(units) > 0 {
								units = append(units, utf16Units(" ")...)
							}
							values = append(values, text)
							units = append(units, valueUnits(textValue)...)
						}
					}
					candidates = append(candidates, strings.Join(values, " "))
					candidateUnits = append(candidateUnits, units)
				}
			}
		}
	}
	for index, candidate := range candidates {
		units := trimNodeSpaceUnits(candidateUnits[index])
		if candidate != "" && len(units) > 0 {
			return truncateNodeStringUnits(units, 240)
		}
	}
	return utf16Units(DefaultFallback)
}

func truncateNodeStringUnits(units []uint16, limit int) []uint16 {
	if len(units) <= limit {
		return cloneUnits(units)
	}
	if limit <= 3 {
		return cloneUnits(units[:limit])
	}
	result := cloneUnits(units[:limit-3])
	return append(result, utf16Units("...")...)
}
