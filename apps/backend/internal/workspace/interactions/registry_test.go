package interactions

import (
	"context"
	"testing"
)

func TestCommandRegistryMatchesNodeWhitespaceAndBOM(t *testing.T) {
	registry, err := NewCommandRegistry(CommandDefinition{
		Name:     "echo",
		Contexts: []CommandContext{CommandContextDirect},
		ParseArguments: func(raw string) (any, error) {
			return raw, nil
		},
		Execute: func(context.Context, CommandExecution) (CommandResult, error) {
			return CommandResult{}, nil
		},
	})
	if err != nil {
		t.Fatalf("NewCommandRegistry() error = %v", err)
	}

	tests := []struct {
		name   string
		source string
		want   string
	}{
		{name: "BOM around command and argument", source: "\ufeff/echo\ufeffhello\ufeff", want: "hello"},
		{name: "unicode JavaScript whitespace", source: "\u2003/echo\u2003hello\u202f", want: "hello"},
		{name: "U+0085 is preserved in arguments", source: "/echo \u0085hello\u0085", want: "\u0085hello\u0085"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			recognized, recognizeErr := registry.Recognize(test.source, RecognitionContext{ConversationType: "direct"})
			if recognizeErr != nil {
				t.Fatalf("Recognize() error = %v", recognizeErr)
			}
			if recognized == nil {
				t.Fatal("Recognize() returned nil")
			}
			if recognized.Name != "echo" {
				t.Fatalf("Name = %q, want echo", recognized.Name)
			}
			if recognized.RawArguments != test.want {
				t.Fatalf("RawArguments = %q, want %q", recognized.RawArguments, test.want)
			}
			if got, ok := recognized.Arguments.(string); !ok || got != test.want {
				t.Fatalf("Arguments = %#v, want %q", recognized.Arguments, test.want)
			}
		})
	}
}

func TestCommandRegistryDoesNotTreatU0085AsACommandDelimiter(t *testing.T) {
	registry, err := NewCommandRegistry(CommandDefinition{
		Name:     "echo",
		Contexts: []CommandContext{CommandContextDirect},
		Execute: func(context.Context, CommandExecution) (CommandResult, error) {
			return CommandResult{}, nil
		},
	})
	if err != nil {
		t.Fatalf("NewCommandRegistry() error = %v", err)
	}

	recognized, recognizeErr := registry.Recognize("/echo\u0085hello\u0085", RecognitionContext{ConversationType: "direct"})
	if recognizeErr != nil {
		t.Fatalf("Recognize() error = %v", recognizeErr)
	}
	if recognized != nil {
		t.Fatalf("Recognize() = %#v, want nil", recognized)
	}
}

func TestRegistryNormalizationUsesJavaScriptWhitespace(t *testing.T) {
	registry, err := NewCommandRegistry(CommandDefinition{
		Name:     "\ufeff Echo \ufeff",
		Contexts: []CommandContext{CommandContextDirect},
		Execute: func(context.Context, CommandExecution) (CommandResult, error) {
			return CommandResult{}, nil
		},
	})
	if err != nil {
		t.Fatalf("NewCommandRegistry() error = %v", err)
	}
	if registry.Get("\ufeffECHO\ufeff") == nil {
		t.Fatal("Get() did not normalize BOM like Node")
	}
	if registry.Get("\u0085echo\u0085") != nil {
		t.Fatal("Get() treated U+0085 as JavaScript whitespace")
	}

	workflow, err := NewWorkflowRegistry(WorkflowDefinition{
		Type: "\u2003Echo.Flow\uFEFF",
		Initialize: func(context.Context, WorkflowExecution) (WorkflowResult, error) {
			return WorkflowResult{}, nil
		},
		Continue: func(context.Context, WorkflowExecution) (WorkflowResult, error) {
			return WorkflowResult{}, nil
		},
	})
	if err != nil {
		t.Fatalf("NewWorkflowRegistry() error = %v", err)
	}
	if workflow.Get(" ECHO.FLOW ", 1) == nil {
		t.Fatal("WorkflowRegistry.Get() did not normalize JavaScript whitespace")
	}
	if workflow.Get("\u0085echo.flow\u0085", 1) != nil {
		t.Fatal("WorkflowRegistry.Get() treated U+0085 as JavaScript whitespace")
	}
}
