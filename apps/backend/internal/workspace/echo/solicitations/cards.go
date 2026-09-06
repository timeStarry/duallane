package solicitations

import (
	"context"
	"errors"
	"math"
	"strings"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	workspacecards "github.com/timestarry/duallane/apps/backend/internal/workspace/cards"
)

const (
	CardMaxPayloadBytes = 20 * 1024
	CardMaxTextBytes    = 14 * 1024
)

// ValidateCardPayload is the domain validator passed to the shared card
// registry. It performs no authorization and never trusts client-provided
// action or actor fields.
func ValidateCardPayload(payload any) (any, error) {
	normalized, err := workspacecards.NormalizeCardPayload(payload, workspacecards.Limits{
		MaxPayloadBytes: CardMaxPayloadBytes,
		MaxTextBytes:    CardMaxTextBytes,
	}, false)
	if err != nil {
		return nil, normalizeCardValidationError(err)
	}
	object, ok := normalized.(map[string]any)
	if !ok {
		return nil, NewError(CodeCardDomainInvalid, MessageCardDomainInvalid, 422)
	}
	if err := validateCardObject(object); err != nil {
		return nil, err
	}
	return object, nil
}

func validateCardObject(payload map[string]any) *Error {
	publicID, ok := payload["publicId"].(string)
	if !ok || !publicIDPattern.MatchString(publicID) {
		return NewError(CodeCardDomainInvalid, MessageCardDomainInvalid, 422)
	}
	status, ok := payload["status"].(string)
	if !ok || !contains(SolicitationStatuses[:], status) {
		return NewError(CodeCardDomainInvalid, MessageCardDomainInvalid, 422)
	}
	revision, ok := cardInteger(payload["revision"])
	if !ok || revision < 1 {
		return NewError(CodeCardDomainInvalid, MessageCardDomainInvalid, 422)
	}
	options, ok := payload["options"].([]any)
	if !ok || len(options) < MinOptions || len(options) > MaxOptions {
		return NewError(CodeCardDomainInvalid, MessageCardDomainInvalid, 422)
	}
	for _, value := range options {
		option, ok := value.(map[string]any)
		if !ok {
			return NewError(CodeCardDomainInvalid, MessageCardDomainInvalid, 422)
		}
		if id, ok := option["id"].(string); !ok || !identifierPattern.MatchString(id) {
			return NewError(CodeCardDomainInvalid, MessageCardDomainInvalid, 422)
		}
		if label, ok := option["label"].(string); !ok || strings.TrimSpace(label) == "" {
			return NewError(CodeCardDomainInvalid, MessageCardDomainInvalid, 422)
		}
	}
	return nil
}

// ValidateCardActionInput mirrors the Node action boundary. The returned map
// is JSON-shaped because the shared cards registry invokes validators after
// its generic payload sanitizer.
func ValidateCardActionInput(actionID string, input map[string]any) (map[string]any, error) {
	if actionID != "vote" || input == nil {
		return nil, NewError(CodeCardActionInputInvalid, MessageCardActionInputInvalid, 422)
	}
	keyValue, ok := input["idempotencyKey"].(string)
	if !ok {
		return nil, NewError(CodeCardActionInputInvalid, MessageCardActionInputInvalid, 422)
	}
	key, keyErr := normalizeIdempotencyKey(keyValue)
	if keyErr != nil {
		return nil, NewError(CodeCardActionInputInvalid, MessageCardActionInputInvalid, 422)
	}
	optionValue := input["optionIds"]
	if optionValue == nil {
		optionValue = input["selectedOptionIds"]
	}
	optionIDs, optionErr := actionOptionIDs(optionValue)
	if optionErr != nil {
		return nil, optionErr
	}
	return map[string]any{"optionIds": optionIDs, "idempotencyKey": key}, nil
}

type CardActionInput struct {
	ActorID                 string
	SpaceID                 string
	PublicID                string
	ConversationID          string
	OptionIDs               []string
	ExpectedRevision        int64
	ExpectedRevisionPresent bool
	IdempotencyKey          string
	Meta                    auth.RequestMeta
}

// CardActionAdapter describes ordinary solicitation calls outside a card action.
type CardActionAdapter interface {
	Vote(context.Context, VoteInput) (*Solicitation, error)
	ProjectCard(context.Context, GetInput) (*CardProjection, error)
}

// TransactionalCardActionAdapter is the atomic card-action seam. The parent
// cards executor must expose a typed solicitation view of the same transaction.
// A separate provider avoids conflicting WriteAudit/WriteEvent method types.
type TransactionalCardActionAdapter interface {
	CardActionAdapter
	VoteInTx(context.Context, Tx, VoteInput) (*Solicitation, error)
	ProjectCardInTx(context.Context, Tx, GetInput) (*CardProjection, error)
}

type CardTransactionProvider interface {
	SolicitationTransaction() Tx
}

func NewCardDefinition(adapter TransactionalCardActionAdapter) workspacecards.CardDefinition {
	return workspacecards.CardDefinition{
		CardType:        CardType,
		SchemaVersion:   CardSchemaVersion,
		AllowPublicURLs: false,
		Limits: workspacecards.Limits{
			MaxPayloadBytes: CardMaxPayloadBytes,
			MaxTextBytes:    CardMaxTextBytes,
		},
		ValidatePayload: ValidateCardPayload,
		Actions: map[string]workspacecards.CardAction{
			"vote": {
				ValidateInput: func(input any) (any, error) {
					object, ok := input.(map[string]any)
					if !ok {
						return nil, NewError(CodeCardActionInputInvalid, MessageCardActionInputInvalid, 422)
					}
					return ValidateCardActionInput("vote", object)
				},
				Authorize: func(_ context.Context, authorization workspacecards.CardAuthorization) (bool, error) {
					return authorization.Actor != nil && authorization.Actor.Kind == "human" && authorization.Actor.Role != "auditor", nil
				},
				Execute: func(ctx context.Context, actionContext workspacecards.CardActionContext) (workspacecards.CardActionResult, error) {
					if adapter == nil || actionContext.Actor == nil {
						return workspacecards.CardActionResult{}, internalError("execute echo solicitation card action", errors.New("card action adapter is required"))
					}
					provider, ok := actionContext.Tx.(CardTransactionProvider)
					if !ok {
						return workspacecards.CardActionResult{}, internalError("execute echo solicitation card action", errors.New("shared solicitation transaction bridge is required"))
					}
					tx := provider.SolicitationTransaction()
					if tx == nil {
						return workspacecards.CardActionResult{}, internalError("execute echo solicitation card action", errors.New("shared solicitation transaction is required"))
					}
					input, ok := actionContext.Input.(map[string]any)
					if !ok {
						return workspacecards.CardActionResult{}, NewError(CodeCardActionInputInvalid, MessageCardActionInputInvalid, 422)
					}
					optionValue := input["optionIds"]
					if optionValue == nil {
						optionValue = input["selectedOptionIds"]
					}
					optionIDs, optionErr := actionOptionIDs(optionValue)
					if optionErr != nil {
						return workspacecards.CardActionResult{}, optionErr
					}
					key, keyErr := input["idempotencyKey"].(string)
					if !keyErr {
						return workspacecards.CardActionResult{}, NewError(CodeCardActionInputInvalid, MessageCardActionInputInvalid, 422)
					}
					publicID, publicErr := cardPublicID(actionContext.Payload)
					if publicErr != nil {
						return workspacecards.CardActionResult{}, publicErr
					}
					conversationID := ""
					if actionContext.Card.ConversationID != nil {
						conversationID = *actionContext.Card.ConversationID
					}
					voteInput := VoteInput{
						ActorID: actionContext.Actor.ID, SpaceID: actionContext.Card.SpaceID,
						PublicID: publicID, ConversationID: conversationID, OptionIDs: optionIDs,
						ExpectedRevision: actionContext.Card.Revision, ExpectedRevisionPresent: true, IdempotencyKey: key,
						Meta: actionContext.Request.Meta,
					}
					result, err := adapter.VoteInTx(ctx, tx, voteInput)
					if err != nil {
						return workspacecards.CardActionResult{}, err
					}
					if result == nil {
						return workspacecards.CardActionResult{}, internalError("execute echo solicitation card action", errors.New("vote result is required"))
					}
					projectionInput := GetInput{ActorID: actionContext.Actor.ID, SpaceID: actionContext.Card.SpaceID, PublicID: result.PublicID, ConversationID: conversationID, Meta: actionContext.Request.Meta}
					projection, err := adapter.ProjectCardInTx(ctx, tx, projectionInput)
					if err != nil {
						return workspacecards.CardActionResult{}, err
					}
					if projection == nil {
						return workspacecards.CardActionResult{}, internalError("project echo solicitation card action", errors.New("card projection is required"))
					}
					return workspacecards.CardActionResult{CardPayload: projection.Payload, Result: SafeCardActionResult(*result)}, nil
				},
			},
		},
	}
}

func CreateCardRegistry(adapter TransactionalCardActionAdapter) (*workspacecards.Registry, error) {
	return workspacecards.NewRegistry(NewCardDefinition(adapter))
}

func SafeCardActionResult(result Solicitation) map[string]any {
	return map[string]any{
		"publicId":          result.PublicID,
		"status":            result.Status,
		"revision":          result.Revision,
		"selectedOptionIds": append([]string{}, result.SelectedOptionIDs...),
		"counts":            result.Counts,
		"voteCount":         result.VoteCount,
	}
}

func actionOptionIDs(value any) ([]string, *Error) {
	values, ok := value.([]any)
	if !ok {
		if typed, typedOK := value.([]string); typedOK {
			return normalizeOptionIDs(typed)
		}
		return nil, NewError(CodeCardActionInputInvalid, MessageCardActionInputInvalid, 422)
	}
	result := make([]string, len(values))
	for index, value := range values {
		text, ok := value.(string)
		if !ok {
			return nil, NewError(CodeCardActionInputInvalid, MessageCardActionInputInvalid, 422)
		}
		result[index] = text
	}
	normalized, err := normalizeOptionIDs(result)
	if err != nil {
		return nil, NewError(CodeCardActionInputInvalid, MessageCardActionInputInvalid, 422)
	}
	return normalized, nil
}

func cardPublicID(payload any) (string, *Error) {
	object, ok := payload.(map[string]any)
	if !ok {
		return "", NewError(CodeCardDomainInvalid, MessageCardDomainInvalid, 422)
	}
	value, ok := object["publicId"].(string)
	if !ok {
		return "", NewError(CodeCardDomainInvalid, MessageCardDomainInvalid, 422)
	}
	return normalizePublicID(value)
}

func cardInteger(value any) (int64, bool) {
	switch number := value.(type) {
	case int:
		return int64(number), true
	case int8:
		return int64(number), true
	case int16:
		return int64(number), true
	case int32:
		return int64(number), true
	case int64:
		return number, true
	case uint:
		if uint64(number) > math.MaxInt64 {
			return 0, false
		}
		return int64(number), true
	case uint8:
		return int64(number), true
	case uint16:
		return int64(number), true
	case uint32:
		return int64(number), true
	case uint64:
		if number > math.MaxInt64 {
			return 0, false
		}
		return int64(number), true
	case float64:
		if math.IsNaN(number) || math.IsInf(number, 0) || math.Trunc(number) != number || number > math.MaxInt64 || number < math.MinInt64 {
			return 0, false
		}
		return int64(number), true
	default:
		return 0, false
	}
}

func normalizeCardValidationError(err error) error {
	var validation *workspacecards.CardValidationError
	if errors.As(err, &validation) && validation != nil {
		return NewError(validation.Code, validation.Message, 422)
	}
	return internalError("normalize echo solicitation card", err)
}

var _ CardActionAdapter = (*Service)(nil)

func (s *Service) CardActionVote(ctx context.Context, input CardActionInput) (*Solicitation, error) {
	return s.Vote(ctx, VoteInput{ActorID: input.ActorID, SpaceID: input.SpaceID, PublicID: input.PublicID, ConversationID: input.ConversationID, OptionIDs: input.OptionIDs, ExpectedRevision: input.ExpectedRevision, ExpectedRevisionPresent: input.ExpectedRevisionPresent || input.ExpectedRevision != 0, IdempotencyKey: input.IdempotencyKey, Meta: input.Meta})
}

func (s *Service) CardActionProjection(ctx context.Context, input CardActionInput) (*CardProjection, error) {
	return s.ProjectCard(ctx, GetInput{ActorID: input.ActorID, SpaceID: input.SpaceID, PublicID: input.PublicID, ConversationID: input.ConversationID, Meta: input.Meta})
}
