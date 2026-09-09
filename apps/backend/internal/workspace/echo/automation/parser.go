package automation

import (
	"regexp"
	"strings"
)

type WorkflowIDArguments struct {
	WorkflowID *string
}

type ReleaseArguments struct {
	Version string
}

type RequirementIDArguments struct {
	PublicID string
}

type RejectArguments struct {
	PublicID string
	Response *string
}

type ListArguments struct {
	Phase          string
	Status         string
	ArchiveOutcome string
}

var releaseVersionPattern = regexp.MustCompile(`(?i)^(?:v)?(\d+\.\d+\.\d+)$`)
var requirementIDPattern = regexp.MustCompile(`(?i)^REQ-\d{4}-\d{4}$`)

func parseEmptyArguments(raw string) (any, error) {
	if trimNodeWhitespace(raw) != "" {
		return nil, commandArgumentsError("该命令不接受参数")
	}
	return map[string]any{}, nil
}

func parseWorkflowIDArguments(raw string) (any, error) {
	tokens, err := tokenize(raw)
	if err != nil {
		return nil, err
	}
	if len(tokens) > 1 {
		return nil, commandArgumentsError("工作流参数无效")
	}
	result := WorkflowIDArguments{}
	if len(tokens) == 1 {
		value := tokens[0]
		result.WorkflowID = &value
	}
	return result, nil
}

func parsePublishArguments(raw string) (any, error) {
	tokens, err := tokenize(raw)
	if err != nil {
		return nil, err
	}
	if len(tokens) > 0 {
		return nil, commandArgumentsError("请通过引导流程填写征集内容")
	}
	return map[string]any{}, nil
}

func parseReleaseArguments(raw string) (any, error) {
	tokens, err := tokenize(raw)
	if err != nil {
		return nil, err
	}
	if len(tokens) != 1 {
		return nil, commandArgumentsError("需要版本号，例如 /release 0.15.1")
	}
	match := releaseVersionPattern.FindStringSubmatch(tokens[0])
	if match == nil {
		return nil, commandArgumentsError("需要版本号，例如 /release 0.15.1")
	}
	return ReleaseArguments{Version: match[1]}, nil
}

func parseRequirementWorkflowArguments(raw string) (any, error) {
	tokens, err := tokenize(raw)
	if err != nil {
		return nil, err
	}
	if len(tokens) > 1 {
		return nil, commandArgumentsError("请通过引导流程填写完整内容")
	}
	typeValue := "requirement"
	if len(tokens) == 1 && strings.EqualFold(tokens[0], "feedback") {
		typeValue = "problem"
	}
	return map[string]any{"type": typeValue}, nil
}

func parseFeedbackArguments(raw string) (any, error) {
	value, err := parseRequirementWorkflowArguments(raw)
	if err != nil {
		return nil, err
	}
	arguments := value.(map[string]any)
	arguments["type"] = "problem"
	return arguments, nil
}

func parseRequirementIDArguments(raw string) (any, error) {
	tokens, err := tokenize(raw)
	if err != nil {
		return nil, err
	}
	if len(tokens) != 1 || !requirementIDPattern.MatchString(tokens[0]) {
		return nil, commandArgumentsError("需要有效的需求编号")
	}
	return RequirementIDArguments{PublicID: strings.ToUpper(tokens[0])}, nil
}

func parseRejectArguments(raw string) (any, error) {
	tokens, err := tokenize(raw)
	if err != nil {
		return nil, err
	}
	if len(tokens) < 1 || len(tokens) > 2 || !requirementIDPattern.MatchString(tokens[0]) {
		return nil, commandArgumentsError("需要需求编号和可选说明")
	}
	result := RejectArguments{PublicID: strings.ToUpper(tokens[0])}
	if len(tokens) == 2 {
		value := tokens[1]
		result.Response = &value
	}
	return result, nil
}

func parseListArguments(raw string) (any, error) {
	tokens, err := tokenize(raw)
	if err != nil {
		return nil, err
	}
	if len(tokens) > 1 {
		return nil, commandArgumentsError("列表筛选参数无效")
	}
	if len(tokens) == 0 {
		return ListArguments{}, nil
	}
	mapping := map[string]ListArguments{
		"pending":     {Phase: "proposal", Status: "pending_review"},
		"submitted":   {Phase: "proposal", Status: "pending_review"},
		"collected":   {Phase: "formal", Status: "planned"},
		"planned":     {Phase: "formal", Status: "planned"},
		"in_progress": {Phase: "formal", Status: "in_progress"},
		"implemented": {Phase: "formal", Status: "delivered"},
		"delivered":   {Phase: "formal", Status: "delivered"},
		"rejected":    {Phase: "archived", Status: "archived", ArchiveOutcome: "rejected"},
	}
	result, ok := mapping[strings.ToLower(tokens[0])]
	if !ok {
		return nil, commandArgumentsError("未知的需求筛选状态")
	}
	return result, nil
}

// tokenize mirrors the active Node parser: quoted tokens, JavaScript
// whitespace splitting, a 16-token cap, and the 4 KiB check on the unquoted
// branch. Quoted content follows Node's early continue and is not checked
// until a later unquoted character is processed.
func tokenize(raw string) ([]string, error) {
	text := trimNodeWhitespace(raw)
	if text == "" {
		return []string{}, nil
	}
	result := make([]string, 0, 4)
	current := strings.Builder{}
	var quote rune
	for _, character := range text {
		if quote != 0 {
			if character == quote {
				quote = 0
			} else {
				current.WriteRune(character)
			}
			// Node's quoted branch continues before the token-count and
			// byte-length checks. This intentionally permits a quoted token
			// above 4 KiB, matching the active runtime contract.
			continue
		} else {
			switch {
			case character == '\'' || character == '"':
				quote = character
			case isWhitespace(character):
				if current.Len() > 0 {
					result = append(result, current.String())
					current.Reset()
				}
			default:
				current.WriteRune(character)
			}
		}
		if len(result) > 16 || current.Len() > 4*1024 {
			return nil, commandArgumentsError("命令参数过长")
		}
	}
	if quote != 0 {
		return nil, commandArgumentsError("命令引号不完整")
	}
	if current.Len() > 0 {
		result = append(result, current.String())
	}
	if len(result) > 16 {
		return nil, commandArgumentsError("命令参数过多")
	}
	return result, nil
}

func isWhitespace(value rune) bool {
	return isNodeWhitespace(value)
}

// isNodeWhitespace mirrors ECMAScript's String.trim and /\s/u sets. Go's
// unicode.IsSpace includes U+0085, which JavaScript does not, and excludes
// U+FEFF, which JavaScript treats as whitespace.
func isNodeWhitespace(value rune) bool {
	switch {
	case value == '\u0009' || value == '\u000A' || value == '\u000B' || value == '\u000C' || value == '\u000D':
		return true
	case value == '\u0020' || value == '\u00A0' || value == '\u1680':
		return true
	case value >= '\u2000' && value <= '\u200A':
		return true
	case value == '\u2028' || value == '\u2029' || value == '\u202F' || value == '\u205F' || value == '\u3000' || value == '\uFEFF':
		return true
	default:
		return false
	}
}

func trimNodeWhitespace(value string) string {
	return strings.TrimFunc(value, isNodeWhitespace)
}
