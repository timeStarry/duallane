package solicitations

import (
	"context"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestNodeRequestHashGoldenUsesJSONStringifyEncoding(t *testing.T) {
	deadline := time.Date(2026, 8, 20, 0, 0, 0, 0, time.UTC)
	intent := createIntent{
		Title:            "T<&\u2028",
		Description:      "Desc>&",
		Question:         "Q\u2029",
		Options:          []string{"A<&", "B"},
		ChoiceMode:       ChoiceSingle,
		MinSelections:    1,
		MaxSelections:    1,
		AllowVoteChange:  true,
		ResultVisibility: ResultVisibilityAggregate,
		DeliveryPolicy:   DeliveryPolicyAllActiveMembers,
		Deadline:         &deadline,
	}
	if got, want := createRequestHash(DefaultSpaceID, "usr_owner", intent), "5904fced4cf5af4c6bb767bf184fb70a26d7ebdd934d018b1bd156c18c48ad00"; got != want {
		t.Fatalf("create hash = %s, want %s; JSON=%s", got, want, nodeJSONString(nodeObject{
			{key: "spaceId", value: DefaultSpaceID},
			{key: "actorId", value: "usr_owner"},
			{key: "title", value: intent.Title},
			{key: "description", value: intent.Description},
			{key: "question", value: intent.Question},
			{key: "options", value: intent.Options},
			{key: "choiceMode", value: intent.ChoiceMode},
			{key: "minSelections", value: intent.MinSelections},
			{key: "maxSelections", value: intent.MaxSelections},
			{key: "allowVoteChange", value: intent.AllowVoteChange},
			{key: "resultVisibility", value: intent.ResultVisibility},
			{key: "deliveryPolicy", value: intent.DeliveryPolicy},
			{key: "deadline", value: formatTime(deadline)},
		}))
	}
	encoded := nodeJSONString(nodeObject{{key: "value", value: "<&>\u2028\u2029"}})
	if strings.Contains(encoded, `\u003c`) || strings.Contains(encoded, `\u2028`) || strings.Contains(encoded, `\u2029`) {
		t.Fatalf("Node JSON compatibility encoding escaped literal characters: %q", encoded)
	}
	if got, want := transitionRequestHash(DefaultSpaceID, "SOL-2026-0001", "publish", StatusOpen), "d4163fb1539d0459eb8e75ac4e3ee1ec2e006b87672fe9a7860947351de42470"; got != want {
		t.Fatalf("transition hash = %s, want %s", got, want)
	}
	if got, want := voteRequestHash(DefaultSpaceID, "SOL-2026-0001", []string{"opt<&", "opt2"}, 0), "f94da17ef985593ef4e763950af0cf9ce0676e0cd7b3d7e7c8fe8a526d18c73d"; got != want {
		t.Fatalf("vote hash = %s, want %s", got, want)
	}
}

func TestSolicitationValidationAndCardBoundary(t *testing.T) {
	if _, err := normalizeCreateInput(CreateInput{Title: "title", Description: "description", Question: "question", Options: []string{"A", "a"}}); err == nil || err.Code != CodeOptionsInvalid {
		t.Fatalf("duplicate options error = %v", err)
	}
	if _, err := normalizeCreateInput(CreateInput{Title: "title", Description: "description", Question: "question", Options: []string{"A", "B"}, ChoiceMode: ChoiceSingle, MaxSelections: 2}); err == nil || err.Code != CodeSelectionInvalid {
		t.Fatalf("single selection error = %v", err)
	}
	payload, err := ValidateCardPayload(map[string]any{
		"publicId": "SOL-2026-0001", "status": StatusOpen, "revision": 2,
		"options": []any{map[string]any{"id": "echo_sol_opt_a", "label": "A", "position": 0, "count": 1}, map[string]any{"id": "echo_sol_opt_b", "label": "B", "position": 1, "count": 0}},
	})
	if err != nil || payload == nil {
		t.Fatalf("card payload: %#v, %v", payload, err)
	}
	input, err := ValidateCardActionInput("vote", map[string]any{"optionIds": []any{"echo_sol_opt_a"}, "idempotencyKey": "card-1"})
	if err != nil || !reflect.DeepEqual(input["optionIds"], []string{"echo_sol_opt_a"}) {
		t.Fatalf("card input: %#v, %v", input, err)
	}
	if _, err := ValidateCardActionInput("vote", map[string]any{"optionIds": []any{"echo_sol_opt_a", "echo_sol_opt_a"}, "idempotencyKey": "card-2"}); err == nil {
		t.Fatal("duplicate card option was accepted")
	}
}

func TestDomainPresenceBitsPreserveExplicitZeroAndEmptyValues(t *testing.T) {
	base := CreateInput{
		Title: "title", Description: "description", Question: "question", Options: []string{"A", "B"},
	}
	if _, err := normalizeCreateInput(base); err != nil {
		t.Fatalf("omitted defaults rejected: %v", err)
	}

	base.MinSelections = 0
	base.Presence.MinSelections = true
	if _, err := normalizeCreateInput(base); err == nil || err.Code != CodeSelectionInvalid {
		t.Fatalf("explicit minSelections zero error = %v", err)
	}

	base = CreateInput{Title: "title", Description: "description", Question: "question", Options: []string{"A", "B"}, MaxSelections: 0}
	base.Presence.MaxSelections = true
	if _, err := normalizeCreateInput(base); err == nil || err.Code != CodeSelectionInvalid {
		t.Fatalf("explicit maxSelections zero error = %v", err)
	}

	base = CreateInput{Title: "title", Description: "description", Question: "question", Options: []string{"A", "B"}, ChoiceMode: ""}
	base.Presence.ChoiceMode = true
	if _, err := normalizeCreateInput(base); err == nil || err.Code != CodeChoiceModeInvalid {
		t.Fatalf("explicit choiceMode empty error = %v", err)
	}

	base = CreateInput{Title: "title", Description: "", Detail: "fallback", Question: "question", Options: []string{"A", "B"}}
	if intent, err := normalizeCreateInput(base); err != nil || intent.Description != "fallback" {
		t.Fatalf("omitted description fallback = %#v err=%v", intent, err)
	}
	base.Presence.Description = true
	if _, err := normalizeCreateInput(base); err == nil || err.Code != CodeDescriptionInvalid {
		t.Fatalf("explicit description empty error = %v", err)
	}

	if got, err := normalizeLimitWithPresence(0, false); err != nil || got != DefaultListLimit {
		t.Fatalf("omitted limit = %d err=%v", got, err)
	}
	if _, err := normalizeLimitWithPresence(0, true); err == nil || err.Code != CodeLimitInvalid {
		t.Fatalf("explicit limit zero error = %v", err)
	}
	if revision, err := normalizeExpectedRevision(0, false); err != nil || revision != nil {
		t.Fatalf("omitted revision = %v err=%v", revision, err)
	}
	if _, err := normalizeExpectedRevision(0, true); err == nil || err.Code != CodeExpectedRevisionInvalid {
		t.Fatalf("explicit revision zero error = %v", err)
	}
}

type fakeConversationAccess struct {
	active bool
}

func (f fakeConversationAccess) ConversationMemberActive(context.Context, string, string, string) (bool, error) {
	return f.active, nil
}

func TestConversationTargetRequiresInjectedAuthorization(t *testing.T) {
	service := &Service{conversationAccess: fakeConversationAccess{active: false}}
	if err := service.authorizeConversation(context.Background(), DefaultSpaceID, "conv-target", "usr-member"); asDomainError(err) == nil || asDomainError(err).Code != CodeSolicitationNotFound {
		t.Fatalf("inactive target error = %v", err)
	}
	service.conversationAccess = fakeConversationAccess{active: true}
	if err := service.authorizeConversation(context.Background(), DefaultSpaceID, "conv-target", "usr-member"); err != nil {
		t.Fatalf("active target error = %v", err)
	}
	service.conversationAccess = nil
	if err := service.authorizeConversation(context.Background(), DefaultSpaceID, "conv-target", "usr-member"); asDomainError(err) == nil || asDomainError(err).Code != CodeInternal {
		t.Fatalf("missing target adapter error = %v", err)
	}
}
