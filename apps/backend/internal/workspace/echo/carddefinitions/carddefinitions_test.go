package carddefinitions

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"testing"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/cards"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/requirements"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/solicitations"
)

type goldenLimits struct {
	MaxPayloadBytes int `json:"maxPayloadBytes"`
	MaxDepth        int `json:"maxDepth"`
	MaxNodes        int `json:"maxNodes"`
	MaxTextBytes    int `json:"maxTextBytes"`
}

type goldenAction struct {
	ID     string       `json:"id"`
	Limits goldenLimits `json:"limits"`
}

type goldenDefinition struct {
	CardType        string                  `json:"cardType"`
	SchemaVersion   int                     `json:"schemaVersion"`
	AllowPublicURLs bool                    `json:"allowPublicUrls"`
	Limits          goldenLimits            `json:"limits"`
	Actions         map[string]goldenAction `json:"actions"`
}

type goldenValidation struct {
	Name     string       `json:"name"`
	CardType string       `json:"cardType"`
	Payload  any          `json:"payload"`
	Expected any          `json:"expected"`
	Error    *goldenError `json:"error"`
}

type goldenError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type cardGolden struct {
	Definitions []goldenDefinition `json:"definitions"`
	Validation  []goldenValidation `json:"validation"`
}

func TestCardDefinitionsMatchNodeGolden(t *testing.T) {
	golden := loadCardGolden(t)
	registry, err := NewRegistry(Options{})
	if err != nil {
		t.Fatal(err)
	}
	if got := registry.Types(); !reflect.DeepEqual(got, []string{
		"echo.release@1",
		"echo.request-list@1",
		"echo.request-status@1",
		"echo.request@1",
		"echo.solicitation@1",
	}) {
		t.Fatalf("registry types = %#v", got)
	}
	for _, expected := range golden.Definitions {
		expected := expected
		t.Run(expected.CardType, func(t *testing.T) {
			definition := registry.Get(expected.CardType, expected.SchemaVersion)
			if definition == nil {
				t.Fatalf("definition %s@%d is missing", expected.CardType, expected.SchemaVersion)
			}
			if got := snapshotDefinition(*definition); !reflect.DeepEqual(got, expected) {
				t.Fatalf("definition = %#v, expected %#v", got, expected)
			}
		})
	}
}

func TestCardValidatorsMatchNodeGolden(t *testing.T) {
	golden := loadCardGolden(t)
	registry, err := NewRegistry(Options{})
	if err != nil {
		t.Fatal(err)
	}
	for _, testCase := range golden.Validation {
		testCase := testCase
		t.Run(testCase.Name, func(t *testing.T) {
			definition := registry.Get(testCase.CardType, 1)
			if definition == nil || definition.ValidatePayload == nil {
				t.Fatalf("validator for %s is missing", testCase.CardType)
			}
			got, err := definition.ValidatePayload(testCase.Payload)
			if testCase.Error != nil {
				var validationErr *cards.CardValidationError
				if !errors.As(err, &validationErr) || validationErr.Code != testCase.Error.Code || validationErr.Message != testCase.Error.Message {
					t.Fatalf("error = %v, expected = %+v", err, testCase.Error)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !reflect.DeepEqual(got, testCase.Expected) {
				t.Fatalf("payload = %#v, expected %#v", got, testCase.Expected)
			}
		})
	}
}

func TestResourceBindingForEchoCards(t *testing.T) {
	cases := []struct {
		cardType, resourceType string
	}{
		{requirements.CardTypeRequirement, ResourceKindRequirement},
		{requirements.CardTypeRequirementStatus, ResourceKindRequirement},
		{solicitations.CardType, ResourceKindSolicitation},
		{"echo.release", ResourceKindRelease},
	}
	for _, testCase := range cases {
		binding, err := ResourceBindingForCard(testCase.cardType, "resource-1")
		if err != nil {
			t.Fatalf("%s: %v", testCase.cardType, err)
		}
		if binding.SourceKind != cards.SourceEcho || binding.ResourceType != testCase.resourceType || binding.ResourceID != "resource-1" {
			t.Fatalf("%s binding = %#v", testCase.cardType, binding)
		}
	}
	for _, testCase := range []struct{ cardType, resourceID string }{
		{"echo.unknown", "resource-1"},
		{requirements.CardTypeRequirementList, "resource-1"},
		{requirements.CardTypeRequirement, ""},
		{requirements.CardTypeRequirement, "resource/escape"},
	} {
		if _, err := ResourceBindingForCard(testCase.cardType, testCase.resourceID); err == nil {
			t.Fatalf("accepted invalid binding %#v", testCase)
		}
	}
}

func loadCardGolden(t *testing.T) cardGolden {
	t.Helper()
	data, err := os.ReadFile("testdata/node-definitions.json")
	if err != nil {
		t.Fatal(err)
	}
	var golden cardGolden
	if err := json.Unmarshal(data, &golden); err != nil {
		t.Fatal(err)
	}
	return golden
}

func snapshotDefinition(definition cards.CardDefinition) goldenDefinition {
	actions := make(map[string]goldenAction, len(definition.Actions))
	for id, action := range definition.Actions {
		actions[id] = goldenAction{ID: action.ID, Limits: goldenLimits{
			MaxPayloadBytes: action.Limits.MaxPayloadBytes,
			MaxDepth:        action.Limits.MaxDepth,
			MaxNodes:        action.Limits.MaxNodes,
			MaxTextBytes:    action.Limits.MaxTextBytes,
		}}
	}
	return goldenDefinition{
		CardType:        definition.CardType,
		SchemaVersion:   definition.SchemaVersion,
		AllowPublicURLs: definition.AllowPublicURLs,
		Limits: goldenLimits{
			MaxPayloadBytes: definition.Limits.MaxPayloadBytes,
			MaxDepth:        definition.Limits.MaxDepth,
			MaxNodes:        definition.Limits.MaxNodes,
			MaxTextBytes:    definition.Limits.MaxTextBytes,
		},
		Actions: actions,
	}
}

type requirementActionAdapter struct {
	transaction requirements.Tx
	transition  requirements.TransitionInput
	project     requirements.GetInput
}

func (a *requirementActionAdapter) TransitionInTx(_ context.Context, tx requirements.Tx, input requirements.TransitionInput) (*requirements.Requirement, error) {
	a.transaction = tx
	a.transition = input
	return &requirements.Requirement{PublicID: input.PublicID, State: requirements.StateCollected, Phase: requirements.PhaseFormal, Status: requirements.StatusPlanned, Revision: input.ExpectedRevision + 1, Detail: "private detail", Response: stringPointer("private response")}, nil
}

func (a *requirementActionAdapter) ProjectCardInTx(_ context.Context, tx requirements.Tx, input requirements.GetInput) (*requirements.CardProjection, error) {
	if tx != a.transaction {
		return nil, errors.New("requirement projection used a different transaction")
	}
	a.project = input
	return &requirements.CardProjection{Payload: map[string]any{"publicId": input.PublicID, "detail": "private projection"}}, nil
}

type solicitationActionAdapter struct {
	transaction solicitations.Tx
	vote        solicitations.VoteInput
	project     solicitations.GetInput
}

func (a *solicitationActionAdapter) Vote(context.Context, solicitations.VoteInput) (*solicitations.Solicitation, error) {
	return nil, errors.New("standalone Vote must not be used")
}

func (a *solicitationActionAdapter) ProjectCard(context.Context, solicitations.GetInput) (*solicitations.CardProjection, error) {
	return nil, errors.New("standalone ProjectCard must not be used")
}

func (a *solicitationActionAdapter) VoteInTx(_ context.Context, tx solicitations.Tx, input solicitations.VoteInput) (*solicitations.Solicitation, error) {
	a.transaction = tx
	a.vote = input
	return &solicitations.Solicitation{PublicID: input.PublicID, Status: solicitations.StatusOpen, Revision: input.ExpectedRevision + 1, SelectedOptionIDs: append([]string{}, input.OptionIDs...), Counts: map[string]int64{"opt-a": 1}, VoteCount: int64Pointer(1), Description: "private description"}, nil
}

func (a *solicitationActionAdapter) ProjectCardInTx(_ context.Context, tx solicitations.Tx, input solicitations.GetInput) (*solicitations.CardProjection, error) {
	if tx != a.transaction {
		return nil, errors.New("solicitation projection used a different transaction")
	}
	a.project = input
	return &solicitations.CardProjection{Payload: map[string]any{"publicId": input.PublicID, "description": "private projection"}}, nil
}

type requirementCardTx struct{ requirements.Tx }

type solicitationCardTx struct{ solicitations.Tx }

type sharedCardTx struct {
	cards.Tx
	requirements  requirements.Tx
	solicitations solicitations.Tx
	record        *cards.CardRecord
}

func (tx sharedCardTx) RequirementTransaction() requirements.Tx   { return tx.requirements }
func (tx sharedCardTx) SolicitationTransaction() solicitations.Tx { return tx.solicitations }
func (tx sharedCardTx) GetCard(_ context.Context, _, cardID string) (*cards.CardRecord, error) {
	if tx.record == nil {
		return nil, nil
	}
	copy := *tx.record
	return &copy, nil
}

func TestRequirementActionUsesOuterTransactionAndSafeResult(t *testing.T) {
	adapter := &requirementActionAdapter{}
	definition := CardDefinitions(Options{Requirements: adapter})[0]
	validated, err := definition.Actions["collect"].ValidateInput(map[string]any{"idempotencyKey": "runtime-domain-key", "response": "handled"})
	if err != nil {
		t.Fatal(err)
	}
	domainTx := &requirementCardTx{}
	cardRecord := requirementCardRecord("spc_fixture", "REQ-2026-0001")
	result, err := definition.Actions["collect"].Execute(context.Background(), cards.CardActionContext{
		Tx: sharedCardTx{requirements: domainTx, record: cardRecord}, Actor: &auth.Actor{ID: "usr_owner", Kind: "human", Role: "owner"},
		Card:    cards.Card{ID: cardRecord.ID, SpaceID: "spc_fixture", Block: cards.CardBlock{CardType: requirements.CardTypeRequirement, SchemaVersion: requirements.CardSchemaVersion}, Revision: 7},
		Payload: map[string]any{"publicId": "REQ-2026-0001"}, Input: validated,
	})
	if err != nil {
		t.Fatal(err)
	}
	if adapter.transaction != domainTx || adapter.transition.IdempotencyKey != "runtime-domain-key" || adapter.transition.ExpectedRevision != 7 || adapter.transition.Response != "handled" {
		t.Fatalf("transition = %#v tx=%T", adapter.transition, adapter.transaction)
	}
	if result.CardPayload == nil || result.Result == nil {
		t.Fatalf("result = %#v", result)
	}
	resultMap := result.Result.(map[string]any)
	if _, leaked := resultMap["detail"]; leaked {
		t.Fatal("private requirement detail leaked through action result")
	}
	if _, leaked := resultMap["response"]; leaked {
		t.Fatal("private requirement response leaked through action result")
	}
	if allowed, err := definition.Actions["collect"].Authorize(context.Background(), cards.CardAuthorization{Actor: &auth.Actor{ID: "usr_member", Kind: "human", Role: "member"}}); err != nil || allowed {
		t.Fatalf("member authorization = %v, %v", allowed, err)
	}
}

func TestSolicitationActionReusesTypedAdapterAndSafeResult(t *testing.T) {
	adapter := &solicitationActionAdapter{}
	definition := CardDefinitions(Options{Solicitations: adapter})[3]
	validated, err := definition.Actions["vote"].ValidateInput(map[string]any{"idempotencyKey": "runtime-vote-key", "optionIds": []any{"opt-a"}})
	if err != nil {
		t.Fatal(err)
	}
	domainTx := &solicitationCardTx{}
	conversationID := "conv_fixture"
	cardRecord := solicitationCardRecord("spc_fixture", "SOL-2026-0001")
	result, err := definition.Actions["vote"].Execute(context.Background(), cards.CardActionContext{
		Tx: sharedCardTx{solicitations: domainTx, record: cardRecord}, Actor: &auth.Actor{ID: "usr_member", Kind: "human", Role: "member"},
		Card:    cards.Card{ID: cardRecord.ID, SpaceID: "spc_fixture", ConversationID: &conversationID, Block: cards.CardBlock{CardType: solicitations.CardType, SchemaVersion: solicitations.CardSchemaVersion}, Revision: 3},
		Payload: map[string]any{"publicId": "SOL-2026-0001"}, Input: validated,
	})
	if err != nil {
		t.Fatal(err)
	}
	if adapter.transaction != domainTx || adapter.vote.IdempotencyKey != "runtime-vote-key" || adapter.vote.ExpectedRevision != 3 || !reflect.DeepEqual(adapter.vote.OptionIDs, []string{"opt-a"}) {
		t.Fatalf("vote = %#v tx=%T", adapter.vote, adapter.transaction)
	}
	resultMap := result.Result.(map[string]any)
	if _, leaked := resultMap["description"]; leaked {
		t.Fatal("private solicitation description leaked through action result")
	}
}

func TestActionsFailClosedWithoutTypedProvider(t *testing.T) {
	definition := CardDefinitions(Options{Requirements: &requirementActionAdapter{}})[0]
	input, err := definition.Actions["collect"].ValidateInput(map[string]any{"idempotencyKey": "runtime-key"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = definition.Actions["collect"].Execute(context.Background(), cards.CardActionContext{
		Tx:      sharedCardTx{record: requirementCardRecord("spc_fixture", "REQ-2026-0001")},
		Actor:   &auth.Actor{ID: "usr_owner", Kind: "human", Role: "owner"},
		Card:    cards.Card{ID: "card_echo_requirement", SpaceID: "spc_fixture", Block: cards.CardBlock{CardType: requirements.CardTypeRequirement, SchemaVersion: requirements.CardSchemaVersion}, Revision: 1},
		Payload: map[string]any{"publicId": "REQ-2026-0001"}, Input: input,
	})
	var domainErr *cards.Error
	if !errors.As(err, &domainErr) || domainErr.StatusCode != 503 {
		t.Fatalf("provider error = %v", err)
	}
}

func TestRequirementActionRejectsSourceResourceAndSpaceMismatch(t *testing.T) {
	const (
		spaceID  = "spc_fixture"
		publicID = "REQ-2026-0001"
	)
	cases := []struct {
		name   string
		mutate func(*cards.CardRecord)
	}{
		{
			name:   "custom bot source",
			mutate: func(record *cards.CardRecord) { record.SourceKind = cards.SourceCustomBot },
		},
		{
			name:   "echo source wrong resource id",
			mutate: func(record *cards.CardRecord) { value := "REQ-2026-0002"; record.ResourceID = &value },
		},
		{
			name:   "echo source wrong resource type",
			mutate: func(record *cards.CardRecord) { value := ResourceKindSolicitation; record.ResourceType = &value },
		},
		{
			name:   "wrong space",
			mutate: func(record *cards.CardRecord) { record.SpaceID = "spc_other" },
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			adapter := &requirementActionAdapter{}
			definition := CardDefinitions(Options{Requirements: adapter})[0]
			input, err := definition.Actions["collect"].ValidateInput(map[string]any{"idempotencyKey": "runtime-key"})
			if err != nil {
				t.Fatal(err)
			}
			record := requirementCardRecord(spaceID, publicID)
			testCase.mutate(record)
			_, err = definition.Actions["collect"].Execute(context.Background(), cards.CardActionContext{
				Tx:      sharedCardTx{requirements: &requirementCardTx{}, record: record},
				Actor:   &auth.Actor{ID: "usr_owner", Kind: "human", Role: "owner"},
				Card:    cards.Card{ID: record.ID, SpaceID: spaceID, Block: cards.CardBlock{CardType: requirements.CardTypeRequirement, SchemaVersion: requirements.CardSchemaVersion}, Revision: 1},
				Payload: map[string]any{"publicId": publicID}, Input: input,
			})
			var cardErr *cards.Error
			if !errors.As(err, &cardErr) || cardErr.Code != cards.CodeCardNotFound || cardErr.StatusCode != 404 {
				t.Fatalf("error = %v, want safe card-not-found", err)
			}
			if adapter.transaction != nil {
				t.Fatal("domain transition ran for an unbound card")
			}
		})
	}
}

func requirementCardRecord(spaceID, publicID string) *cards.CardRecord {
	resourceType := ResourceKindRequirement
	resourceID := publicID
	return &cards.CardRecord{
		ID: "card_echo_requirement", SpaceID: spaceID,
		CardType: requirements.CardTypeRequirement, SchemaVersion: requirements.CardSchemaVersion,
		SourceKind: cards.SourceEcho, ResourceType: &resourceType, ResourceID: &resourceID,
	}
}

func TestSolicitationActionRejectsSourceResourceAndCardIdentityMismatch(t *testing.T) {
	const (
		spaceID  = "spc_fixture"
		publicID = "SOL-2026-0001"
	)
	cases := []struct {
		name   string
		mutate func(*cards.CardRecord, *cards.Card)
	}{
		{
			name:   "custom bot source",
			mutate: func(record *cards.CardRecord, _ *cards.Card) { record.SourceKind = cards.SourceCustomBot },
		},
		{
			name:   "echo source wrong resource id",
			mutate: func(record *cards.CardRecord, _ *cards.Card) { value := "SOL-2026-0002"; record.ResourceID = &value },
		},
		{
			name: "echo source wrong resource type",
			mutate: func(record *cards.CardRecord, _ *cards.Card) {
				value := ResourceKindRequirement
				record.ResourceType = &value
			},
		},
		{
			name:   "wrong space",
			mutate: func(record *cards.CardRecord, _ *cards.Card) { record.SpaceID = "spc_other" },
		},
		{
			name:   "wrong stored card type",
			mutate: func(record *cards.CardRecord, _ *cards.Card) { record.CardType = requirements.CardTypeRequirement },
		},
		{
			name:   "wrong card id",
			mutate: func(_ *cards.CardRecord, card *cards.Card) { card.ID = "card_other" },
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			adapter := &solicitationActionAdapter{}
			definition := CardDefinitions(Options{Solicitations: adapter})[3]
			input, err := definition.Actions["vote"].ValidateInput(map[string]any{
				"idempotencyKey": "runtime-vote-key", "optionIds": []any{"opt-a"},
			})
			if err != nil {
				t.Fatal(err)
			}
			record := solicitationCardRecord(spaceID, publicID)
			card := cards.Card{ID: record.ID, SpaceID: spaceID, Block: cards.CardBlock{
				CardType: solicitations.CardType, SchemaVersion: solicitations.CardSchemaVersion,
			}, Revision: 1}
			testCase.mutate(record, &card)
			_, err = definition.Actions["vote"].Execute(context.Background(), cards.CardActionContext{
				Tx:      sharedCardTx{solicitations: &solicitationCardTx{}, record: record},
				Actor:   &auth.Actor{ID: "usr_member", Kind: "human", Role: "member"},
				Card:    card,
				Payload: map[string]any{"publicId": publicID}, Input: input,
			})
			var cardErr *cards.Error
			if !errors.As(err, &cardErr) || cardErr.Code != cards.CodeCardNotFound || cardErr.StatusCode != 404 {
				t.Fatalf("error = %v, want safe card-not-found", err)
			}
			if adapter.transaction != nil {
				t.Fatal("solicitation vote ran for an unbound card")
			}
		})
	}
}

func solicitationCardRecord(spaceID, publicID string) *cards.CardRecord {
	resourceType := ResourceKindSolicitation
	resourceID := publicID
	return &cards.CardRecord{
		ID: "card_echo_solicitation", SpaceID: spaceID,
		CardType: solicitations.CardType, SchemaVersion: solicitations.CardSchemaVersion,
		SourceKind: cards.SourceEcho, ResourceType: &resourceType, ResourceID: &resourceID,
	}
}

func stringPointer(value string) *string { return &value }
func int64Pointer(value int64) *int64    { return &value }
