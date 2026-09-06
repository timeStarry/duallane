// Package carddefinitions contains the Echo-owned definitions registered with
// the shared Workspace card service. It deliberately owns no repository,
// transaction, or runtime wiring; composition supplies the domain adapters.
package carddefinitions

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/cards"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/releases"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/requirements"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/solicitations"
)

const (
	ResourceKindRequirement  = "echo.requirement"
	ResourceKindSolicitation = "echo.solicitation"
	ResourceKindRelease      = "echo.release"
)

// ResourceBinding is the source/resource tuple that the Echo delivery writer
// must put on every recipient-bound card. The shared card service persists and
// checks these values; they are not accepted from a client payload.
type ResourceBinding struct {
	SourceKind   cards.SourceKind
	ResourceType string
	ResourceID   string
}

// ResourceBindingForCard centralizes the Echo card-to-domain-resource mapping
// used by composition. It does not authorize a caller; the owning domain and
// delivery transaction still re-check membership/ownership before writing a
// card or message.
func ResourceBindingForCard(cardType, resourceID string) (ResourceBinding, error) {
	cardType, err := cards.NormalizeCardType(cardType)
	if err != nil {
		return ResourceBinding{}, err
	}
	resourceID, err = cards.NormalizeIdentifier(resourceID, cards.CodeCardInvalidResource, "卡片资源无效")
	if err != nil {
		return ResourceBinding{}, err
	}
	resourceType := ""
	switch cardType {
	case requirements.CardTypeRequirement, requirements.CardTypeRequirementStatus:
		resourceType = ResourceKindRequirement
	case requirements.CardTypeRequirementList:
		// A list is an actor-filtered projection over many requirements, not
		// one resource-backed delivery card. It must not be assigned a made-up
		// resource ID or weaken the underlying per-row authorization.
		return ResourceBinding{}, &cards.CardValidationError{Code: cards.CodeCardInvalidResource, Message: "Echo 需求列表没有单一资源"}
	case solicitations.CardType:
		resourceType = ResourceKindSolicitation
	case releases.CardType:
		resourceType = ResourceKindRelease
	default:
		return ResourceBinding{}, &cards.CardValidationError{Code: cards.CodeCardInvalidType, Message: "Echo 卡片类型无效"}
	}
	return ResourceBinding{SourceKind: cards.SourceEcho, ResourceType: resourceType, ResourceID: resourceID}, nil
}

// RequirementCardActionAdapter is the only requirement capability used by a
// card action. Both calls receive the caller-owned domain transaction. In
// particular, implementations must not call Transition or ProjectCard here,
// because those methods would acquire a second pool transaction.
type RequirementCardActionAdapter interface {
	TransitionInTx(context.Context, requirements.Tx, requirements.TransitionInput) (*requirements.Requirement, error)
	ProjectCardInTx(context.Context, requirements.Tx, requirements.GetInput) (*requirements.CardProjection, error)
}

// RequirementTransactionProvider is implemented by the concrete shared card
// transaction in composition. The returned value must wrap the same database
// transaction represented by cards.Tx.
type RequirementTransactionProvider interface {
	RequirementTransaction() requirements.Tx
}

// Options supplies optional domain adapters. Definitions remain present when
// an adapter is nil, matching Node's registry shape; an attempted action then
// fails closed with an unavailable error rather than becoming a no-op.
type Options struct {
	Requirements  RequirementCardActionAdapter
	Solicitations solicitations.TransactionalCardActionAdapter
}

// CardDefinitions returns Echo definitions in the same order as
// createEchoCardDefinitions in the active Node runtime: requirements,
// solicitation, then release.
func CardDefinitions(options Options) []cards.CardDefinition {
	return []cards.CardDefinition{
		requirementDefinition(requirements.CardTypeRequirement, options.Requirements),
		requirementDefinition(requirements.CardTypeRequirementStatus, nil),
		requirementListDefinition(),
		solicitationDefinition(options.Solicitations),
		releaseDefinition(),
	}
}

// Definitions is a descriptive alias for callers that already use that name
// for registry input.
func Definitions(options Options) []cards.CardDefinition {
	return CardDefinitions(options)
}

// NewRegistry builds an Echo-only registry. The parent composition layer may
// append topic, Feishu, or other definitions to the returned definition list
// before constructing the process-wide registry.
func NewRegistry(options Options) (*cards.Registry, error) {
	return cards.NewRegistry(CardDefinitions(options)...)
}

func requirementDefinition(cardType string, adapter RequirementCardActionAdapter) cards.CardDefinition {
	limits := cards.Limits{MaxPayloadBytes: 20 * 1024, MaxTextBytes: 14 * 1024}
	allowPublicURLs := true
	if cardType == requirements.CardTypeRequirementStatus {
		limits = cards.Limits{MaxPayloadBytes: 12 * 1024, MaxTextBytes: 8 * 1024}
	}
	return cards.CardDefinition{
		CardType:        cardType,
		SchemaVersion:   requirements.CardSchemaVersion,
		AllowPublicURLs: allowPublicURLs,
		Limits:          limits,
		ValidatePayload: func(payload any) (any, error) {
			value, err := requirements.ValidateRequirementCardPayload(cardType, payload)
			return value, adaptValidationError(err)
		},
		Actions: requirementDefinitionActions(cardType, adapter),
	}
}

func requirementDefinitionActions(cardType string, adapter RequirementCardActionAdapter) map[string]cards.CardAction {
	if cardType != requirements.CardTypeRequirement {
		return nil
	}
	return requirementActions(adapter)
}

func requirementListDefinition() cards.CardDefinition {
	return cards.CardDefinition{
		CardType:        requirements.CardTypeRequirementList,
		SchemaVersion:   requirements.CardSchemaVersion,
		AllowPublicURLs: false,
		Limits:          cards.Limits{MaxPayloadBytes: 16 * 1024, MaxTextBytes: 8 * 1024},
		ValidatePayload: func(payload any) (any, error) {
			value, err := requirements.ValidateRequirementCardPayload(requirements.CardTypeRequirementList, payload)
			return value, adaptValidationError(err)
		},
	}
}

func solicitationDefinition(adapter solicitations.TransactionalCardActionAdapter) cards.CardDefinition {
	definition := solicitations.NewCardDefinition(adapter)
	// Reuse the domain-owned definition and action executor. Only validation
	// errors are adapted to the shared card error shape; action errors must stay
	// intact so a caller-owned transaction can distinguish rejection markers
	// from infrastructure failures.
	definition.ValidatePayload = func(payload any) (any, error) {
		value, err := solicitations.ValidateCardPayload(payload)
		return value, adaptValidationError(err)
	}
	for actionID, action := range definition.Actions {
		original := action.ValidateInput
		if original != nil {
			action.ValidateInput = func(input any) (any, error) {
				value, err := original(input)
				return value, adaptValidationError(err)
			}
		}
		originalExecute := action.Execute
		if originalExecute != nil {
			action.Execute = func(ctx context.Context, actionContext cards.CardActionContext) (cards.CardActionResult, error) {
				if err := validateSolicitationCardBinding(ctx, actionContext); err != nil {
					return cards.CardActionResult{}, err
				}
				return originalExecute(ctx, actionContext)
			}
		}
		definition.Actions[actionID] = action
	}
	return definition
}

func adaptValidationError(err error) error {
	if err == nil {
		return nil
	}
	var requirementErr *requirements.Error
	if errors.As(err, &requirementErr) && requirementErr != nil {
		return &cards.CardValidationError{Code: requirementErr.Code, Message: requirementErr.Message}
	}
	var solicitationErr *solicitations.Error
	if errors.As(err, &solicitationErr) && solicitationErr != nil {
		return &cards.CardValidationError{Code: solicitationErr.Code, Message: solicitationErr.Message}
	}
	return err
}

func actionUnavailable(operation string) error {
	return cards.NewError(cards.CodeInternal, fmt.Sprintf("%s 尚未接线", operation), 503)
}

func invalidActionInput() error {
	return cards.NewError("card.action_input_invalid", "需求操作参数无效", 422)
}

func invalidCardPayload() error {
	return cards.NewError("card.invalid_payload", "Echo 卡片数据无效", 422)
}

func actorID(actorID string) string {
	return strings.TrimSpace(actorID)
}
