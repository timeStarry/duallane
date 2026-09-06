package runtime

import (
	"context"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/cards"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/delivery"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/requirements"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/solicitations"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/interactions"
)

// DeliveryHooks runs only after the underlying domain call has committed.
// Failures do not turn a durable success into a retryable domain rejection;
// the worker repairs persisted delivery rows and requirement projections.
type DeliveryHooks interface {
	SyncRequirement(context.Context, delivery.SyncInput) (delivery.DeliverySummary, error)
	SyncSolicitation(context.Context, delivery.SyncInput) (delivery.DeliverySummary, error)
	SyncRelease(context.Context, delivery.SyncInput) (delivery.DeliverySummary, error)
}

type InteractionService interface {
	ExecuteCommand(context.Context, interactions.ExecuteCommandInput) (interactions.CommandOutcome, error)
	StartWorkflow(context.Context, interactions.StartWorkflowInput) (interactions.Workflow, error)
	GetWorkflow(context.Context, string, string) (interactions.Workflow, error)
	ContinueWorkflow(context.Context, string, interactions.ContinueWorkflowInput) (interactions.WorkflowOutcome, error)
	CancelWorkflow(context.Context, string, interactions.CancelWorkflowInput) (interactions.Workflow, error)
}

type InteractionHooks struct {
	InteractionService
	Delivery DeliveryHooks
	SpaceID  string
}

func (s InteractionHooks) ExecuteCommand(ctx context.Context, input interactions.ExecuteCommandInput) (interactions.CommandOutcome, error) {
	value, err := s.InteractionService.ExecuteCommand(ctx, input)
	if err == nil && value.OK && !value.Replayed {
		s.syncResult(ctx, value.Result, input.Request.Meta)
	}
	return value, err
}

func (s InteractionHooks) ContinueWorkflow(ctx context.Context, actorID string, input interactions.ContinueWorkflowInput) (interactions.WorkflowOutcome, error) {
	value, err := s.InteractionService.ContinueWorkflow(ctx, actorID, input)
	if err == nil && value.Workflow.Status == "completed" {
		s.syncResult(ctx, value.Result, input.Request.Meta)
	}
	return value, err
}

func (s InteractionHooks) syncResult(ctx context.Context, result any, meta auth.RequestMeta) {
	if s.Delivery == nil {
		return
	}
	object, ok := result.(map[string]any)
	if !ok {
		return
	}
	publicID, _ := object["publicId"].(string)
	input := delivery.SyncInput{SpaceID: s.SpaceID, PublicID: publicID, Meta: meta.Safe()}
	switch object["type"] {
	case "requirement-submitted", "requirement-transition":
		if publicID != "" {
			_, _ = s.Delivery.SyncRequirement(ctx, input)
		}
	case "solicitation-published":
		if publicID != "" {
			_, _ = s.Delivery.SyncSolicitation(ctx, input)
		}
	case "release-published":
		input.Version, _ = object["version"].(string)
		if input.Version != "" {
			_, _ = s.Delivery.SyncRelease(ctx, input)
		}
	}
}

type CardService interface {
	ResolveCard(context.Context, string, string, cards.Request) (cards.Resolution, error)
	ExecuteAction(context.Context, cards.ActionInput) (cards.ActionOutcome, error)
}

type CardHooks struct {
	CardService
	Delivery DeliveryHooks
	SpaceID  string
}

func (s CardHooks) ExecuteAction(ctx context.Context, input cards.ActionInput) (cards.ActionOutcome, error) {
	clientID, err := cards.NormalizeIdentifier(input.ClientActionID, cards.CodeCardInvalidClientAction, "客户端操作 ID 无效")
	if err != nil {
		return cards.ActionOutcome{}, err
	}
	// Resolve through the actor-authorized service, never a client card type.
	// Echo alone needs the adapter key: injecting it into generic Feishu
	// actions violates their deliberately empty-input contract. ExecuteAction
	// still rechecks authorization and provenance inside its own transaction.
	resolved, err := s.CardService.ResolveCard(ctx, input.ActorID, input.CardID, cards.Request{Meta: input.Meta})
	if err != nil {
		return cards.ActionOutcome{}, err
	}
	isEcho := resolved.Block.CardType == requirements.CardTypeRequirement || resolved.Block.CardType == solicitations.CardType
	if object, ok := input.Input.(map[string]any); isEcho && (ok || input.Input == nil) {
		copied := make(map[string]any, len(object)+1)
		for key, value := range object {
			copied[key] = value
		}
		copied["idempotencyKey"] = clientID
		input.Input = copied
	}
	value, err := s.CardService.ExecuteAction(ctx, input)
	if err == nil && value.OK && !value.Replayed && isEcho && s.Delivery != nil {
		if result, ok := value.Result.(map[string]any); ok {
			if publicID, ok := result["publicId"].(string); ok && publicID != "" {
				syncInput := delivery.SyncInput{SpaceID: s.SpaceID, PublicID: publicID, Meta: input.Meta.Safe()}
				if input.ActionID == "vote" {
					_, _ = s.Delivery.SyncSolicitation(ctx, syncInput)
				} else {
					_, _ = s.Delivery.SyncRequirement(ctx, syncInput)
				}
			}
		}
	}
	return value, err
}
