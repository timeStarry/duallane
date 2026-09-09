package automation

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/requirements"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/solicitations"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/interactions"
)

var solicitationFields = [...]string{
	"title", "description", "question", "options", "choiceMode", "minSelections",
	"maxSelections", "allowVoteChange", "deadline", "resultVisibility", "deliveryPolicy",
}

var requirementFields = [...]string{
	"type", "title", "detail", "scenario", "expectedResult", "relatedLink",
}

func workflowDefinitions(options Options) []interactions.WorkflowDefinition {
	return []interactions.WorkflowDefinition{
		{
			Type:          PublishWorkflowType,
			Version:       WorkflowVersion,
			Authorize:     ownerWorkflow,
			Initialize:    initializePublishWorkflow,
			Continue:      continuePublishWorkflow(options),
			ValidateState: validatePublishState,
			Project:       projectWorkflow,
		},
		{
			Type:          RequirementWorkflowType,
			Version:       WorkflowVersion,
			Authorize:     nonAuditorWorkflow,
			Initialize:    initializeRequirementWorkflow,
			Continue:      continueRequirementWorkflow(options),
			ValidateState: validateRequirementState,
			Project:       projectWorkflow,
		},
	}
}

func ownerWorkflow(_ context.Context, authorization interactions.WorkflowAuthorization) (bool, error) {
	return authorization.Actor != nil && authorization.Actor.Role == "owner", nil
}

func nonAuditorWorkflow(_ context.Context, authorization interactions.WorkflowAuthorization) (bool, error) {
	return authorization.Actor != nil && authorization.Actor.Role != "auditor", nil
}

func initializePublishWorkflow(_ context.Context, execution interactions.WorkflowExecution) (interactions.WorkflowResult, error) {
	input := mapValue(execution.Input)
	fields := pickFields(input, solicitationFields[:])
	return interactions.WorkflowResult{State: map[string]any{"step": nextStep(fields, publishMissingFields), "fields": fields}}, nil
}

func initializeRequirementWorkflow(_ context.Context, execution interactions.WorkflowExecution) (interactions.WorkflowResult, error) {
	input := mapValue(execution.Input)
	withDefault := cloneMap(input)
	if _, exists := withDefault["type"]; !exists || withDefault["type"] == nil {
		withDefault["type"] = "requirement"
	}
	fields := pickFields(withDefault, requirementFields[:])
	return interactions.WorkflowResult{State: map[string]any{"step": nextStep(fields, requirementMissingFields), "fields": fields}}, nil
}

func continueRequirementWorkflow(options Options) func(context.Context, interactions.WorkflowExecution) (interactions.WorkflowResult, error) {
	return func(ctx context.Context, execution interactions.WorkflowExecution) (interactions.WorkflowResult, error) {
		state, err := workflowState(execution.State)
		if err != nil {
			return interactions.WorkflowResult{}, err
		}
		input, err := workflowInput(execution.Input)
		if err != nil {
			return interactions.WorkflowResult{}, err
		}
		fields := pickFields(mergeMaps(stateFields(state), input), requirementFields[:])
		if isTrue(input["confirm"]) {
			service, serviceErr := requireRequirements(options)
			if serviceErr != nil {
				return interactions.WorkflowResult{}, serviceErr
			}
			provider, providerErr := requireSharedProvider(execution.Tx)
			if providerErr != nil {
				return interactions.WorkflowResult{}, providerErr
			}
			tx, txErr := requireRequirementTransaction(provider)
			if txErr != nil {
				return interactions.WorkflowResult{}, txErr
			}
			if err := ensureActor(execution.Actor); err != nil {
				return interactions.WorkflowResult{}, err
			}
			key := workflowIdempotencyKey(input, execution.Workflow.ID, execution.Workflow.Revision)
			request, inputErr := requirementSubmitInput(execution, fields, key)
			if inputErr != nil {
				return interactions.WorkflowResult{}, inputErr
			}
			var result *requirements.Requirement
			savepointErr := provider.WithEchoSavepoint(ctx, automationSavepointName("workflow-requirement:"+execution.Workflow.ID, execution.Workflow.Revision), func(actionCtx context.Context) error {
				var submitErr error
				result, submitErr = service.SubmitInTx(actionCtx, tx, request)
				if submitErr != nil {
					return submitErr
				}
				return validateRequirement(result)
			})
			if savepointErr != nil {
				var savepointFailure *SavepointFailure
				if errors.As(savepointErr, &savepointFailure) {
					return interactions.WorkflowResult{}, savepointErr
				}
				if marker, ok := asRequirementRejection(savepointErr); ok {
					if auditErr := preserveRequirementRejection(ctx, tx, execution.Actor, execution.Request.Meta, execution.Context.SpaceID, "echo.requirement.submit", marker, nowUTC(options)); auditErr != nil {
						return interactions.WorkflowResult{}, wrapInfrastructure("preserve requirement rejection audit", auditErr)
					}
					return interactions.WorkflowResult{}, publicDomainError(marker.Err)
				}
				return interactions.WorkflowResult{}, publicDomainError(savepointErr)
			}
			return interactions.WorkflowResult{
				State:  map[string]any{"step": "complete", "fields": fields},
				Status: "completed",
				Result: map[string]any{"type": "requirement-submitted", "publicId": result.PublicID, "state": result.State, "phase": result.Phase, "status": result.Status, "archiveOutcome": result.ArchiveOutcome, "duplicateOfPublicId": result.DuplicateOfPublicID, "revision": result.Revision},
			}, nil
		}
		step := nextStep(fields, requirementMissingFields)
		return interactions.WorkflowResult{State: map[string]any{"step": step, "fields": fields}, Result: map[string]any{"type": "workflow-step", "step": step, "missing": requirementMissingFields(fields)}}, nil
	}
}

func continuePublishWorkflow(options Options) func(context.Context, interactions.WorkflowExecution) (interactions.WorkflowResult, error) {
	return func(ctx context.Context, execution interactions.WorkflowExecution) (interactions.WorkflowResult, error) {
		state, err := workflowState(execution.State)
		if err != nil {
			return interactions.WorkflowResult{}, err
		}
		input, err := workflowInput(execution.Input)
		if err != nil {
			return interactions.WorkflowResult{}, err
		}
		fields := pickFields(mergeMaps(stateFields(state), input), solicitationFields[:])
		if !isTrue(input["confirm"]) {
			step := nextStep(fields, publishMissingFields)
			return interactions.WorkflowResult{State: map[string]any{"step": step, "fields": fields}, Result: map[string]any{"type": "workflow-step", "step": step, "missing": publishMissingFields(fields)}}, nil
		}
		service, serviceErr := requireSolicitations(options)
		if serviceErr != nil {
			return interactions.WorkflowResult{}, serviceErr
		}
		provider, providerErr := requireSharedProvider(execution.Tx)
		if providerErr != nil {
			return interactions.WorkflowResult{}, providerErr
		}
		if err := ensureActor(execution.Actor); err != nil {
			return interactions.WorkflowResult{}, err
		}
		key := workflowIdempotencyKey(input, execution.Workflow.ID, execution.Workflow.Revision)
		createInput, inputErr := solicitationCreateInput(execution, fields, key+":create")
		if inputErr != nil {
			return interactions.WorkflowResult{}, inputErr
		}
		tx, txErr := requireSolicitationTransaction(provider)
		if txErr != nil {
			return interactions.WorkflowResult{}, txErr
		}
		var published *solicitations.Solicitation
		action := "echo.solicitation.create"
		savepointName := automationSavepointName(execution.Workflow.ID, execution.Workflow.Revision)
		savepointErr := provider.WithEchoSavepoint(ctx, savepointName, func(actionCtx context.Context) error {
			draft, createErr := service.CreateInTx(actionCtx, tx, createInput)
			if createErr != nil {
				return createErr
			}
			if draft == nil || strings.TrimSpace(draft.PublicID) == "" {
				return invalidResult("征集创建未返回编号")
			}
			action = "echo.solicitation.publish"
			published, createErr = service.PublishInTx(actionCtx, tx, solicitations.TransitionInput{
				ActorID:                 execution.Actor.ID,
				SpaceID:                 execution.Context.SpaceID,
				PublicID:                draft.PublicID,
				IdempotencyKey:          key + ":publish",
				ConversationID:          "",
				Meta:                    execution.Request.Meta,
				ExpectedRevisionPresent: false,
			})
			if createErr == nil {
				createErr = validatePublishedSolicitation(published)
			}
			return createErr
		})
		if savepointErr != nil {
			var savepointFailure *SavepointFailure
			if errors.As(savepointErr, &savepointFailure) {
				return interactions.WorkflowResult{}, savepointErr
			}
			if marker, ok := asSolicitationRejection(savepointErr); ok {
				if auditErr := preserveSolicitationRejection(ctx, tx, execution.Actor, execution.Request.Meta, execution.Context.SpaceID, action, marker, nowUTC(options)); auditErr != nil {
					return interactions.WorkflowResult{}, wrapInfrastructure("preserve solicitation rejection audit", auditErr)
				}
				return interactions.WorkflowResult{}, publicDomainError(marker.Err)
			}
			return interactions.WorkflowResult{}, publicDomainError(savepointErr)
		}
		return interactions.WorkflowResult{
			State:  map[string]any{"step": "complete", "fields": fields},
			Status: "completed",
			Result: map[string]any{"type": "solicitation-published", "publicId": published.PublicID, "status": published.Status, "revision": published.Revision, "options": safeSolicitationOptions(published.Options), "selectedOptionIds": published.SelectedOptionIDs, "counts": published.Counts, "voteCount": published.VoteCount},
		}, nil
	}
}

func validatePublishedSolicitation(solicitation *solicitations.Solicitation) error {
	if solicitation == nil || strings.TrimSpace(solicitation.PublicID) == "" ||
		strings.TrimSpace(solicitation.Status) == "" || solicitation.Revision < 1 {
		return invalidResult("征集发布未返回有效结果")
	}
	return nil
}

func validatePublishState(state any) (any, error) {
	value, ok := state.(map[string]any)
	if !ok || value == nil {
		return state, nil
	}
	fields, hasFields := value["fields"].(map[string]any)
	if !hasFields || fields == nil {
		return state, nil
	}
	if options, exists := fields["options"]; exists && options != nil {
		switch options.(type) {
		case []any, []string:
		default:
			return nil, workflowStateError("征集选项无效")
		}
	}
	return state, nil
}

func validateRequirementState(state any) (any, error) {
	value, ok := state.(map[string]any)
	if !ok || value == nil {
		return nil, workflowStateError("需求流程状态无效")
	}
	if fields, exists := value["fields"]; !exists || fields == nil {
		return nil, workflowStateError("需求流程状态无效")
	} else if _, ok := fields.(map[string]any); !ok {
		return nil, workflowStateError("需求流程状态无效")
	}
	return state, nil
}

func projectWorkflow(_ context.Context, execution interactions.WorkflowProjectionContext) (any, error) {
	state, err := workflowState(execution.State)
	if err != nil {
		return nil, err
	}
	fields := redactFields(stateFields(state))
	return map[string]any{"step": state["step"], "fields": fields}, nil
}

func requirementSubmitInput(execution interactions.WorkflowExecution, fields map[string]any, key string) (requirements.SubmitInput, error) {
	typeValue, err := stringField(fields, "type")
	if err != nil {
		return requirements.SubmitInput{}, workflowStateError("需求类型无效")
	}
	title, err := stringField(fields, "title")
	if err != nil {
		return requirements.SubmitInput{}, workflowStateError("需求标题无效")
	}
	detail, err := stringField(fields, "detail")
	if err != nil {
		return requirements.SubmitInput{}, workflowStateError("需求详细描述无效")
	}
	scenario, err := stringField(fields, "scenario")
	if err != nil {
		return requirements.SubmitInput{}, workflowStateError("需求使用场景无效")
	}
	expected, err := stringField(fields, "expectedResult")
	if err != nil {
		return requirements.SubmitInput{}, workflowStateError("需求预期结果无效")
	}
	related, err := optionalStringField(fields, "relatedLink")
	if err != nil {
		return requirements.SubmitInput{}, workflowStateError("需求相关链接无效")
	}
	return requirements.SubmitInput{ActorID: execution.Actor.ID, SpaceID: execution.Context.SpaceID, Type: typeValue, Title: title, Detail: detail, Scenario: scenario, ExpectedResult: expected, RelatedLink: related, IdempotencyKey: key, Meta: execution.Request.Meta}, nil
}

func solicitationCreateInput(execution interactions.WorkflowExecution, fields map[string]any, key string) (solicitations.CreateInput, error) {
	title, err := stringField(fields, "title")
	if err != nil {
		return solicitations.CreateInput{}, workflowStateError("征集标题无效")
	}
	description, err := stringField(fields, "description")
	if err != nil {
		return solicitations.CreateInput{}, workflowStateError("征集描述无效")
	}
	question, err := stringField(fields, "question")
	if err != nil {
		return solicitations.CreateInput{}, workflowStateError("征集问题无效")
	}
	options, err := stringSliceField(fields, "options")
	if err != nil {
		return solicitations.CreateInput{}, workflowStateError("征集选项无效")
	}
	result := solicitations.CreateInput{ActorID: execution.Actor.ID, SpaceID: execution.Context.SpaceID, Title: title, Description: description, Question: question, Options: options, IdempotencyKey: key, Meta: execution.Request.Meta}
	result.Presence.Description = hasField(fields, "description")
	if detail, ok := fields["detail"]; ok {
		value, valid := detail.(string)
		if !valid {
			return solicitations.CreateInput{}, workflowStateError("征集描述无效")
		}
		result.Detail = value
		result.Presence.Detail = true
	}
	for name, target := range map[string]*string{"choiceMode": &result.ChoiceMode, "deadline": &result.Deadline, "resultVisibility": &result.ResultVisibility, "deliveryPolicy": &result.DeliveryPolicy} {
		if value, exists := fields[name]; exists {
			text, valid := value.(string)
			if !valid {
				return solicitations.CreateInput{}, workflowStateError("征集字段无效")
			}
			*target = text
			switch name {
			case "choiceMode":
				result.Presence.ChoiceMode = true
			case "deadline":
				result.Presence.Deadline = true
			case "resultVisibility":
				result.Presence.ResultVisibility = true
			case "deliveryPolicy":
				result.Presence.DeliveryPolicy = true
			}
		}
	}
	if value, exists := fields["minSelections"]; exists {
		result.MinSelections, err = integerField(value)
		if err != nil {
			return solicitations.CreateInput{}, workflowStateError("征集最少选择数无效")
		}
		result.Presence.MinSelections = true
	}
	if value, exists := fields["maxSelections"]; exists {
		result.MaxSelections, err = integerField(value)
		if err != nil {
			return solicitations.CreateInput{}, workflowStateError("征集最多选择数无效")
		}
		result.Presence.MaxSelections = true
	}
	if value, exists := fields["allowVoteChange"]; exists {
		allowed, valid := value.(bool)
		if !valid {
			return solicitations.CreateInput{}, workflowStateError("征集投票修改策略无效")
		}
		result.AllowVoteChange = &allowed
	}
	return result, nil
}

func workflowState(value any) (map[string]any, error) {
	state, ok := value.(map[string]any)
	if !ok || state == nil {
		return nil, workflowStateError("引导流程状态无效")
	}
	return state, nil
}

func workflowInput(value any) (map[string]any, error) {
	if value == nil {
		return map[string]any{}, nil
	}
	input, ok := value.(map[string]any)
	if !ok {
		return nil, workflowStateError("引导流程输入无效")
	}
	return input, nil
}

func stateFields(state map[string]any) map[string]any {
	fields, _ := state["fields"].(map[string]any)
	if fields == nil {
		return map[string]any{}
	}
	return fields
}

func pickFields(input map[string]any, allowed []string) map[string]any {
	result := make(map[string]any, len(allowed))
	for _, field := range allowed {
		value, exists := input[field]
		if !exists || value == nil {
			continue
		}
		if text, ok := value.(string); ok && text == "" {
			continue
		}
		result[field] = value
	}
	return result
}

func mergeMaps(left, right map[string]any) map[string]any {
	result := cloneMap(left)
	for key, value := range right {
		result[key] = value
	}
	return result
}

func nextStep(fields map[string]any, missing func(map[string]any) []string) string {
	values := missing(fields)
	if len(values) == 0 {
		return "confirm"
	}
	return values[0]
}

func publishMissingFields(fields map[string]any) []string {
	return missingFields(fields, []string{"title", "description", "question", "options"})
}

func requirementMissingFields(fields map[string]any) []string {
	return missingFields(fields, []string{"type", "title", "detail", "scenario", "expectedResult"})
}

func missingFields(fields map[string]any, names []string) []string {
	result := make([]string, 0, len(names))
	for _, name := range names {
		if _, exists := fields[name]; !exists {
			result = append(result, name)
		}
	}
	return result
}

func redactFields(fields map[string]any) map[string]any {
	result := make(map[string]any, len(fields))
	for key, value := range fields {
		if isSensitiveWorkflowField(key) {
			if text, ok := value.(string); ok {
				result[key] = redactText(text)
				continue
			}
		}
		result[key] = value
	}
	return result
}

func isSensitiveWorkflowField(key string) bool {
	switch key {
	case "detail", "scenario", "expectedResult", "description", "question", "response":
		return true
	default:
		return false
	}
}

func redactText(value string) string {
	if value == "" {
		return value
	}
	for _, character := range value {
		return string(character) + "…"
	}
	return ""
}

func workflowIdempotencyKey(input map[string]any, workflowID string, revision int64) string {
	if value, exists := input["idempotencyKey"]; exists && value != nil {
		if text, ok := value.(string); ok {
			return text
		}
	}
	return fmt.Sprintf("workflow-%s-%d", workflowID, revision)
}

func automationSavepointName(workflowID string, revision int64) string {
	sum := sha256.Sum256([]byte(workflowID + ":" + strconv.FormatInt(revision, 10)))
	return "echo_auto_" + hex.EncodeToString(sum[:12])
}

func mapValue(value any) map[string]any {
	if result, ok := value.(map[string]any); ok && result != nil {
		return result
	}
	return map[string]any{}
}

func hasField(fields map[string]any, name string) bool {
	_, ok := fields[name]
	return ok
}

func stringField(fields map[string]any, name string) (string, error) {
	value, ok := fields[name]
	if !ok {
		return "", errors.New("field missing")
	}
	text, ok := value.(string)
	if !ok {
		return "", errors.New("field is not a string")
	}
	return text, nil
}

func optionalStringField(fields map[string]any, name string) (string, error) {
	value, ok := fields[name]
	if !ok || value == nil {
		return "", nil
	}
	text, ok := value.(string)
	if !ok {
		return "", errors.New("field is not a string")
	}
	return text, nil
}

func stringSliceField(fields map[string]any, name string) ([]string, error) {
	value, ok := fields[name]
	if !ok {
		return nil, errors.New("field missing")
	}
	switch values := value.(type) {
	case []string:
		return append([]string(nil), values...), nil
	case []any:
		result := make([]string, 0, len(values))
		for _, item := range values {
			text, ok := item.(string)
			if !ok {
				return nil, errors.New("array item is not a string")
			}
			result = append(result, text)
		}
		return result, nil
	default:
		return nil, errors.New("field is not an array")
	}
}

func integerField(value any) (int, error) {
	var number int64
	switch typed := value.(type) {
	case int:
		return typed, nil
	case int8:
		return int(typed), nil
	case int16:
		return int(typed), nil
	case int32:
		return int(typed), nil
	case int64:
		number = typed
	case uint:
		if uint64(typed) > uint64(math.MaxInt) {
			return 0, errors.New("integer overflow")
		}
		return int(typed), nil
	case uint8:
		return int(typed), nil
	case uint16:
		return int(typed), nil
	case uint32:
		if uint64(typed) > uint64(math.MaxInt) {
			return 0, errors.New("integer overflow")
		}
		return int(typed), nil
	case uint64:
		if typed > uint64(math.MaxInt) {
			return 0, errors.New("integer overflow")
		}
		return int(typed), nil
	case float64:
		if typed != math.Trunc(typed) || typed > float64(math.MaxInt) || typed < float64(-math.MaxInt-1) {
			return 0, errors.New("not an integer")
		}
		return int(typed), nil
	case float32:
		value := float64(typed)
		if value != math.Trunc(value) || value > float64(math.MaxInt) || value < float64(-math.MaxInt-1) {
			return 0, errors.New("not an integer")
		}
		return int(typed), nil
	case string:
		parsed, err := strconv.ParseInt(strings.TrimSpace(typed), 10, 64)
		if err != nil {
			return 0, err
		}
		number = parsed
	default:
		return 0, errors.New("not an integer")
	}
	if number > int64(math.MaxInt) || number < int64(-math.MaxInt-1) {
		return 0, errors.New("integer overflow")
	}
	return int(number), nil
}

func isTrue(value any) bool {
	result, _ := value.(bool)
	return result
}

func safeSolicitationOptions(options []solicitations.SolicitationOption) []map[string]any {
	result := make([]map[string]any, 0, len(options))
	for _, option := range options {
		result = append(result, map[string]any{"id": option.ID, "label": option.Label, "position": option.Position})
	}
	return result
}
