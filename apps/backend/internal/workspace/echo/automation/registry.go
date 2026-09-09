package automation

import "github.com/timestarry/duallane/apps/backend/internal/workspace/interactions"

// Registries is the small composition result consumed by the parent. Card
// definitions/registry intentionally are not included: cards/** is owned by a
// different worker and the parent will compose card actions after its safety
// review.
type Registries struct {
	Commands  *interactions.CommandRegistry
	Workflows *interactions.WorkflowRegistry
}

func NewCommandDefinitions(options Options) []interactions.CommandDefinition {
	return commandDefinitions(options)
}

func NewWorkflowDefinitions(options Options) []interactions.WorkflowDefinition {
	return workflowDefinitions(options)
}

func NewCommandRegistry(options Options) (*interactions.CommandRegistry, error) {
	return interactions.NewCommandRegistry(NewCommandDefinitions(options)...)
}

func NewWorkflowRegistry(options Options) (*interactions.WorkflowRegistry, error) {
	return interactions.NewWorkflowRegistry(NewWorkflowDefinitions(options)...)
}

func NewRegistries(options Options) (*Registries, error) {
	commands, err := NewCommandRegistry(options)
	if err != nil {
		return nil, err
	}
	workflows, err := NewWorkflowRegistry(options)
	if err != nil {
		return nil, err
	}
	return &Registries{Commands: commands, Workflows: workflows}, nil
}
