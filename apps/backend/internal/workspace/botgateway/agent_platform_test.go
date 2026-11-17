package botgateway

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/botpolicy"
)

func TestAgentTaskInputHashBindsAuthorContentAndPlainText(t *testing.T) {
	base := &MessageTrigger{
		AuthorID:    "usr_owner",
		PlainText:   "原始请求",
		ContentJSON: json.RawMessage(`{"format":"duallane.message+json;v=1","plainText":"原始请求","blocks":[{"type":"text","text":"原始请求"}]}`),
	}
	if messageInputHash(nil) != "" {
		t.Fatal("nil trigger must not produce an authorization hash")
	}
	original := messageInputHash(base)
	if original == "" {
		t.Fatal("valid trigger must produce a hash")
	}

	for name, mutate := range map[string]func(*MessageTrigger){
		"author":     func(value *MessageTrigger) { value.AuthorID = "usr_other" },
		"plain text": func(value *MessageTrigger) { value.PlainText = "被修改的请求" },
		"content bytes": func(value *MessageTrigger) {
			value.ContentJSON = json.RawMessage(`{"format":"duallane.message+json;v=1","plainText":"原始请求","blocks":[{"type":"mention","userId":"bot_other"}]}`)
		},
	} {
		t.Run(name, func(t *testing.T) {
			copy := *base
			copy.ContentJSON = append([]byte(nil), base.ContentJSON...)
			mutate(&copy)
			if got := messageInputHash(&copy); got == original {
				t.Fatalf("mutation kept authorization hash %q", got)
			}
		})
	}
}

func TestAgentTaskContextCarriesOnlyTrimmedTaskReference(t *testing.T) {
	ctx := WithAgentTaskID(context.Background(), "  task_example  ")
	if got := AgentTaskID(ctx); got != "task_example" {
		t.Fatalf("task context id = %q, want trimmed id", got)
	}
	if got := AgentTaskID(context.Background()); got != "" {
		t.Fatalf("empty context task id = %q", got)
	}
}

func TestAgentTaskBotSourcePolicyIsOffUntilExplicitlyAllowlisted(t *testing.T) {
	service := &Service{}
	policy := botpolicy.Policy{
		Version:   botpolicy.Version,
		Discovery: botpolicy.DiscoveryPolicy{Audience: botpolicy.AudienceOwnerOnly},
		Direct:    botpolicy.DirectPolicy{Audience: botpolicy.AudienceOwnerOnly},
		Groups:    botpolicy.GroupPolicy{Audience: botpolicy.AudienceCurrentMembers},
	}
	settings := &Settings{AccessPolicy: &policy}
	if service.taskBotSourceAllowed(settings, "bot-other") {
		t.Fatal("Bot source was allowed while the policy default is off")
	}
	policy.Groups.AllowBotTriggers = true
	policy.Groups.AllowedBotIDs = []string{"bot-approved"}
	if !service.taskBotSourceAllowed(settings, "bot-approved") {
		t.Fatal("explicitly allowlisted Bot source was denied")
	}
	if service.taskBotSourceAllowed(settings, "bot-other") {
		t.Fatal("non-allowlisted Bot source was allowed")
	}
	if service.taskBotSourceAllowed(&Settings{}, "bot-approved") {
		t.Fatal("legacy settings must not acquire Bot-to-Bot triggers")
	}
}
