package interactions

import (
	"regexp"
	"strings"
	"unicode/utf8"
)

var (
	commandNamePattern  = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,31}$`)
	workflowTypePattern = regexp.MustCompile(`^[a-z][a-z0-9._-]{0,63}$`)
)

type DefinitionError struct {
	Code    string
	Message string
}

func (e *DefinitionError) Error() string {
	if e == nil {
		return ""
	}
	return e.Code
}

type CommandRegistry struct{ commands map[string]*CommandDefinition }
type WorkflowRegistry struct {
	definitions map[string]*WorkflowDefinition
}

func NewCommandRegistry(definitions ...CommandDefinition) (*CommandRegistry, error) {
	registry := &CommandRegistry{commands: make(map[string]*CommandDefinition)}
	for i := range definitions {
		if _, err := registry.Register(definitions[i]); err != nil {
			return nil, err
		}
	}
	return registry, nil
}
func NewWorkflowRegistry(definitions ...WorkflowDefinition) (*WorkflowRegistry, error) {
	registry := &WorkflowRegistry{definitions: make(map[string]*WorkflowDefinition)}
	for i := range definitions {
		if _, err := registry.Register(definitions[i]); err != nil {
			return nil, err
		}
	}
	return registry, nil
}

func (r *CommandRegistry) Register(input CommandDefinition) (*CommandDefinition, error) {
	name, err := normalizeCommandName(input.Name)
	if err != nil {
		return nil, err
	}
	version := input.Version
	if version == 0 {
		version = 1
	}
	if version < 1 || version > 1_000_000 {
		return nil, &DefinitionError{Code: "command.invalid_version", Message: "版本号无效"}
	}
	contexts := input.Contexts
	if len(contexts) == 0 {
		contexts = []CommandContext{CommandContextDirect, CommandContextMention}
	}
	validContexts := make([]CommandContext, 0, len(contexts))
	seenContexts := map[CommandContext]struct{}{}
	for _, context := range contexts {
		if context != CommandContextDirect && context != CommandContextMention {
			continue
		}
		if _, seen := seenContexts[context]; !seen {
			seenContexts[context] = struct{}{}
			validContexts = append(validContexts, context)
		}
	}
	if len(validContexts) == 0 || input.Execute == nil {
		return nil, &DefinitionError{Code: "interaction.invalid_definition", Message: "命令处理器无效"}
	}
	aliases := make([]string, 0, len(input.Aliases))
	for _, alias := range input.Aliases {
		normalized, err := normalizeCommandName(alias)
		if err != nil {
			return nil, err
		}
		if normalized != name {
			aliases = append(aliases, normalized)
		}
	}
	definition := input
	definition.Name = name
	definition.Version = version
	definition.Contexts = validContexts
	definition.Aliases = uniqueStrings(aliases)
	for _, key := range append([]string{name}, definition.Aliases...) {
		if _, exists := r.commands[key]; exists {
			return nil, &DefinitionError{Code: "command.duplicate_definition", Message: "命令名称或别名重复"}
		}
	}
	copyDefinition := definition
	for _, key := range append([]string{name}, definition.Aliases...) {
		r.commands[key] = &copyDefinition
	}
	return &copyDefinition, nil
}

func (r *CommandRegistry) Get(name string) *CommandDefinition {
	if r == nil {
		return nil
	}
	normalized, err := normalizeCommandName(name)
	if err != nil {
		return nil
	}
	return r.commands[normalized]
}

func (r *CommandRegistry) Recognize(source string, context RecognitionContext) (*RecognizedCommand, error) {
	if utf8.RuneCountInString(source) > MaxCommandTextCodePoints {
		return nil, nil
	}
	match := commandPattern.FindStringSubmatch(source)
	if match == nil {
		return nil, nil
	}
	name := strings.ToLower(strings.TrimSpace(match[1]))
	definition := r.Get(name)
	raw := strings.TrimSpace(match[2])
	if definition == nil {
		return &RecognizedCommand{Type: "unknown_command", Name: name, RawArguments: raw}, nil
	}
	direct := context.ConversationType == "direct" && containsContext(definition.Contexts, CommandContextDirect)
	mentioned := false
	for _, id := range context.MentionedBotIDs {
		if id == context.BotUserID {
			mentioned = true
			break
		}
	}
	mention := context.ConversationType == "group" && mentioned && containsContext(definition.Contexts, CommandContextMention)
	if !direct && !mention {
		return nil, nil
	}
	arguments := any(map[string]any{"text": raw})
	var err error
	if definition.ParseArguments != nil {
		arguments, err = definition.ParseArguments(raw)
		if err != nil {
			return nil, err
		}
	}
	return &RecognizedCommand{Type: "command", Name: definition.Name, RawArguments: raw, Arguments: arguments, Definition: definition}, nil
}

func (r *WorkflowRegistry) Register(input WorkflowDefinition) (*WorkflowDefinition, error) {
	typeName, err := normalizeWorkflowType(input.Type)
	if err != nil {
		return nil, err
	}
	version := input.Version
	if version == 0 {
		version = 1
	}
	if version < 1 || version > 1_000_000 {
		return nil, &DefinitionError{Code: "workflow.invalid_version", Message: "版本号无效"}
	}
	if input.Initialize == nil || input.Continue == nil {
		return nil, &DefinitionError{Code: "interaction.invalid_definition", Message: "引导流程处理器无效"}
	}
	definition := input
	definition.Type = typeName
	definition.Version = version
	key := workflowKey(typeName, version)
	if _, exists := r.definitions[key]; exists {
		return nil, &DefinitionError{Code: "workflow.duplicate_definition", Message: "引导流程定义重复"}
	}
	copyDefinition := definition
	r.definitions[key] = &copyDefinition
	return &copyDefinition, nil
}
func (r *WorkflowRegistry) Get(typeName string, version int) *WorkflowDefinition {
	if r == nil {
		return nil
	}
	typeName, err := normalizeWorkflowType(typeName)
	if err != nil || version < 1 || version > 1_000_000 {
		return nil
	}
	return r.definitions[workflowKey(typeName, version)]
}

var commandPattern = regexp.MustCompile(`(?s)^\s*/([A-Za-z][A-Za-z0-9_-]{0,31})(?:\s+(.*?))?\s*$`)

func normalizeCommandName(value string) (string, error) {
	normalized := strings.ToLower(strings.TrimSpace(value))
	if !commandNamePattern.MatchString(normalized) {
		return "", &DefinitionError{Code: "command.invalid_name", Message: "命令名称无效"}
	}
	return normalized, nil
}
func normalizeWorkflowType(value string) (string, error) {
	normalized := strings.ToLower(strings.TrimSpace(value))
	if !workflowTypePattern.MatchString(normalized) {
		return "", &DefinitionError{Code: "workflow.invalid_type", Message: "引导流程类型无效"}
	}
	return normalized, nil
}
func workflowKey(typeName string, version int) string { return typeName + "@" + strconvItoa(version) }
func strconvItoa(value int) string {
	if value == 0 {
		return "0"
	}
	result := ""
	for value > 0 {
		result = string(rune('0'+value%10)) + result
		value /= 10
	}
	return result
}
func containsContext(values []CommandContext, wanted CommandContext) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}
func uniqueStrings(values []string) []string {
	result := make([]string, 0, len(values))
	seen := map[string]struct{}{}
	for _, value := range values {
		if _, ok := seen[value]; !ok {
			seen[value] = struct{}{}
			result = append(result, value)
		}
	}
	return result
}
