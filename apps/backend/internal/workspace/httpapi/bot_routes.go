package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"mime"
	"net/http"
	"net/url"

	"github.com/go-chi/chi/v5"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/bots"
)

type BotService interface {
	CreateBot(context.Context, bots.CreateInput) (bots.Bot, error)
	ListOwnedBots(context.Context, bots.ListInput) ([]bots.Bot, error)
	GetOwnedBot(context.Context, bots.GetInput) (bots.Bot, error)
	GetConnectionStatus(context.Context, bots.ConnectionInput) (*bots.BotConnection, error)
	TestConnection(context.Context, bots.ConnectionTestInput) (*bots.BotConnection, error)
	GetSettings(context.Context, bots.GetInput) (bots.BotSettings, error)
	UpdateBotSettings(context.Context, bots.UpdateSettingsInput) (bots.BotSettings, error)
	ListGroupPolicies(context.Context, bots.GroupPoliciesInput) ([]bots.GroupPolicy, error)
	UpdateGroupPolicy(context.Context, bots.UpdateGroupPolicyInput) (bots.GroupPolicy, error)
	UpdateContextGrant(context.Context, bots.UpdateContextGrantInput) (bots.ContextGrant, error)
	IssueToken(context.Context, bots.IssueTokenInput) (bots.IssuedToken, error)
	RotateToken(context.Context, bots.IssueTokenInput) (bots.IssuedToken, error)
	ListTokens(context.Context, bots.ListTokensInput) ([]bots.Token, error)
	RevokeToken(context.Context, bots.RevokeTokenInput) (bots.Token, error)
	CreateSetupSession(context.Context, bots.CreateSetupSessionInput) (bots.SetupSession, error)
	GetSetupSession(context.Context, bots.GetSetupSessionInput) (bots.SetupSession, error)
	ApproveSetupSession(context.Context, bots.ApproveSetupInput) (bots.SetupSession, error)
	DenySetupSession(context.Context, bots.DenySetupInput) (bots.SetupSession, error)
	PauseBot(context.Context, bots.TransitionInput) (bots.Bot, error)
	ResumeBot(context.Context, bots.TransitionInput) (bots.Bot, error)
	BeginDeleteBot(context.Context, bots.TransitionInput) (bots.Bot, error)
	FinalizeDeleteBot(context.Context, bots.TransitionInput) (bots.Bot, error)
}

func registerBotRoutes(router chi.Router, options RouterOptions) {
	router.Post("/bots", withActor(options, createBot))
	router.Get("/bots", withActor(options, listBots))
	router.Get("/bots/{botId}", withActor(options, getBot))
	router.Get("/bots/{botId}/settings", withActor(options, getBotSettings))
	router.Patch("/bots/{botId}/settings", withActor(options, updateBotSettings))
	router.Get("/bots/{botId}/group-policies", withActor(options, listBotGroupPolicies))
	router.Patch("/bots/{botId}/group-policies/{conversationId}", withActor(options, updateBotGroupPolicy))
	router.Patch("/bots/{botId}/context-grants/{conversationId}", withActor(options, updateBotContextGrant))
	router.Post("/bots/{botId}/tokens", withActor(options, issueBotToken))
	router.Post("/bots/{botId}/tokens/rotate", withActor(options, rotateBotToken))
	router.Get("/bots/{botId}/tokens", withActor(options, listBotTokens))
	router.Post("/bots/{botId}/tokens/{tokenId}/revoke", withActor(options, revokeBotToken))
	router.Post("/bots/{botId}/setup-sessions", withActor(options, createBotSetupSession))
	router.Get("/bot-setup/{sessionId}", withActor(options, getBotSetupSession))
	router.Post("/bot-setup/{sessionId}/approve", withActor(options, approveBotSetupSession))
	router.Post("/bot-setup/{sessionId}/deny", withActor(options, denyBotSetupSession))
	router.Post("/bots/{botId}/pause", withActor(options, pauseBot))
	router.Post("/bots/{botId}/resume", withActor(options, resumeBot))
	router.Get("/bots/{botId}/connection", withActor(options, getBotConnection))
	router.Post("/bots/{botId}/connection/test", withActor(options, testBotConnection))
	router.Delete("/bots/{botId}", withActor(options, beginDeleteBot))
	router.Post("/bots/{botId}/delete/confirm", withActor(options, finalizeDeleteBot))
}

func createBot(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	fields, ok := requireBotFields(response, request, options, false)
	if !ok {
		return
	}
	if !onlyBotFields(fields, "name") || !requiredBotString(fields, "name") {
		writeError(response, invalidBotRequest())
		return
	}
	result, err := options.Bots.CreateBot(request.Context(), bots.CreateInput{ActorID: actor.ID, Name: objectFieldString(fields, "name"), Meta: requestMeta(request, options)})
	writeResult(response, http.StatusCreated, map[string]any{"bot": result}, err)
}

func listBots(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Bots) {
		return
	}
	result, err := options.Bots.ListOwnedBots(request.Context(), bots.ListInput{ActorID: actor.ID, Meta: requestMeta(request, options)})
	writeResult(response, http.StatusOK, map[string]any{"bots": result}, err)
}

func getBot(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Bots) {
		return
	}
	result, err := options.Bots.GetOwnedBot(request.Context(), botGetInput(request, actor, options))
	writeResult(response, http.StatusOK, map[string]any{"bot": result}, err)
}

func getBotConnection(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Bots) {
		return
	}
	result, err := options.Bots.GetConnectionStatus(request.Context(), bots.ConnectionInput{
		ActorID: actor.ID, BotID: chi.URLParam(request, "botId"), Meta: requestMeta(request, options),
	})
	writeResult(response, http.StatusOK, map[string]any{"connection": result}, err)
}

func testBotConnection(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Bots) {
		return
	}
	// Node ignores this route's body after HTTP JSON parsing. Preserve that
	// behavior without forwarding caller-supplied provider or credential data.
	var raw json.RawMessage
	if err := decodeJSON(response, request, &raw); err != nil {
		writeError(response, err)
		return
	}
	mediaType, _, _ := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if mediaType == "application/json" && len(bytes.TrimSpace(raw)) == 0 {
		writeError(response, &publicError{Code: "request.invalid_json", Message: "请求内容不是有效 JSON", StatusCode: http.StatusBadRequest})
		return
	}
	result, err := options.Bots.TestConnection(request.Context(), bots.ConnectionTestInput{
		ActorID: actor.ID, BotID: chi.URLParam(request, "botId"), Meta: requestMeta(request, options),
	})
	writeResult(response, http.StatusOK, map[string]any{"connection": result}, err)
}

func getBotSettings(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Bots) {
		return
	}
	result, err := options.Bots.GetSettings(request.Context(), botGetInput(request, actor, options))
	writeResult(response, http.StatusOK, map[string]any{"settings": result}, err)
}

func updateBotSettings(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	fields, ok := requireBotFields(response, request, options, false)
	if !ok {
		return
	}
	patch := make(map[string]any, len(fields))
	for key, raw := range fields {
		var value any
		if json.Unmarshal(raw, &value) != nil {
			writeError(response, invalidObjectRequest("bot.invalid_request"))
			return
		}
		patch[key] = value
	}
	result, err := options.Bots.UpdateBotSettings(request.Context(), bots.UpdateSettingsInput{
		ActorID: actor.ID, BotID: chi.URLParam(request, "botId"), Patch: patch, Meta: requestMeta(request, options),
	})
	writeResult(response, http.StatusOK, map[string]any{"settings": result}, err)
}

func listBotGroupPolicies(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Bots) {
		return
	}
	result, err := options.Bots.ListGroupPolicies(request.Context(), bots.GroupPoliciesInput{
		ActorID: actor.ID, BotID: chi.URLParam(request, "botId"), Meta: requestMeta(request, options),
	})
	writeResult(response, http.StatusOK, map[string]any{"policies": result}, err)
}

func updateBotGroupPolicy(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	fields, ok := requireBotFields(response, request, options, false)
	if !ok {
		return
	}
	allowTrigger, valid := optionalBotBool(fields, "allowTrigger")
	if !valid {
		writeError(response, invalidBotRequest())
		return
	}
	allowContext, valid := optionalBotBool(fields, "allowContext")
	if !valid {
		writeError(response, invalidBotRequest())
		return
	}
	maxMessages, valid := optionalBotInt(fields, "maxMessages")
	if !valid {
		writeError(response, invalidBotRequest())
		return
	}
	result, err := options.Bots.UpdateGroupPolicy(request.Context(), bots.UpdateGroupPolicyInput{
		ActorID: actor.ID, BotID: chi.URLParam(request, "botId"), ConversationID: chi.URLParam(request, "conversationId"),
		Status: objectFieldString(fields, "status"), AllowTrigger: allowTrigger,
		AllowContext: allowContext, MaxMessages: maxMessages, Meta: requestMeta(request, options),
	})
	writeResult(response, http.StatusOK, map[string]any{"policy": result}, err)
}

func updateBotContextGrant(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	fields, ok := requireBotFields(response, request, options, false)
	if !ok {
		return
	}
	allowTrigger, valid := optionalBotBool(fields, "allowTrigger")
	if !valid {
		writeError(response, invalidBotRequest())
		return
	}
	allowContext, valid := optionalBotBool(fields, "allowContext")
	if !valid {
		writeError(response, invalidBotRequest())
		return
	}
	maxMessages, valid := optionalBotInt(fields, "maxMessages")
	if !valid {
		writeError(response, invalidBotRequest())
		return
	}
	result, err := options.Bots.UpdateContextGrant(request.Context(), bots.UpdateContextGrantInput{
		ActorID: actor.ID, BotID: chi.URLParam(request, "botId"), ConversationID: chi.URLParam(request, "conversationId"),
		AllowTrigger: allowTrigger, AllowContext: allowContext,
		MaxMessages: maxMessages, Meta: requestMeta(request, options),
	})
	writeResult(response, http.StatusOK, map[string]any{"grant": result}, err)
}

func issueBotToken(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	issueOrRotateBotToken(response, request, actor, options, false)
}

func rotateBotToken(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	issueOrRotateBotToken(response, request, actor, options, true)
}

func issueOrRotateBotToken(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions, rotate bool) {
	fields, ok := requireBotFields(response, request, options, true)
	if !ok {
		return
	}
	if !onlyBotFields(fields, "scopes", "expiresAt") || !optionalBotStringSlice(fields, "scopes", 1, len(bots.BotScopeAllowlist)) || !optionalBotNullableString(fields, "expiresAt") {
		writeError(response, invalidBotRequest())
		return
	}
	input := bots.IssueTokenInput{ActorID: actor.ID, BotID: chi.URLParam(request, "botId"), Scopes: objectFieldStringSlice(fields, "scopes"), ExpiresAt: objectFieldString(fields, "expiresAt"), Meta: requestMeta(request, options)}
	var result bots.IssuedToken
	var err error
	if rotate {
		result, err = options.Bots.RotateToken(request.Context(), input)
	} else {
		result, err = options.Bots.IssueToken(request.Context(), input)
	}
	writeResult(response, http.StatusCreated, map[string]any{"token": result.Raw, "tokenRecord": result.Token}, err)
}

func listBotTokens(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Bots) {
		return
	}
	result, err := options.Bots.ListTokens(request.Context(), bots.ListTokensInput{ActorID: actor.ID, BotID: chi.URLParam(request, "botId"), Meta: requestMeta(request, options)})
	writeResult(response, http.StatusOK, map[string]any{"tokens": result}, err)
}

func revokeBotToken(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Bots) {
		return
	}
	result, err := options.Bots.RevokeToken(request.Context(), bots.RevokeTokenInput{ActorID: actor.ID, BotID: chi.URLParam(request, "botId"), TokenID: chi.URLParam(request, "tokenId"), Meta: requestMeta(request, options)})
	writeResult(response, http.StatusOK, map[string]any{"token": result}, err)
}

func createBotSetupSession(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	fields, ok := requireBotFields(response, request, options, true)
	if !ok {
		return
	}
	if !onlyBotFields(fields, "requestedScopes", "conversationIds") || !optionalBotStringSlice(fields, "requestedScopes", 0, 10) || !optionalBotStringSlice(fields, "conversationIds", 0, 200) {
		writeError(response, invalidBotRequest())
		return
	}
	result, err := options.Bots.CreateSetupSession(request.Context(), bots.CreateSetupSessionInput{
		ActorID: actor.ID, BotID: chi.URLParam(request, "botId"), RequestedScopes: objectFieldStringSlice(fields, "requestedScopes"),
		ConversationIDs: objectFieldStringSlice(fields, "conversationIds"), Meta: requestMeta(request, options),
	})
	writeResult(response, http.StatusCreated, map[string]any{"session": result, "setupUrl": "/workspace/account/bot?setup=" + url.QueryEscape(result.ID)}, err)
}

func getBotSetupSession(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Bots) {
		return
	}
	result, err := options.Bots.GetSetupSession(request.Context(), bots.GetSetupSessionInput{ActorID: actor.ID, SetupID: chi.URLParam(request, "sessionId"), Meta: requestMeta(request, options)})
	writeResult(response, http.StatusOK, map[string]any{"session": result}, err)
}

func approveBotSetupSession(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	fields, ok := requireBotFields(response, request, options, true)
	if !ok {
		return
	}
	if !onlyBotFields(fields, "scopes", "conversationIds") || !optionalBotStringSlice(fields, "scopes", 0, 10) || !optionalBotStringSlice(fields, "conversationIds", 0, 200) {
		writeError(response, invalidBotRequest())
		return
	}
	result, err := options.Bots.ApproveSetupSession(request.Context(), bots.ApproveSetupInput{
		ActorID: actor.ID, SetupID: chi.URLParam(request, "sessionId"), Scopes: objectFieldStringSlice(fields, "scopes"),
		ConversationIDs: objectFieldStringSlice(fields, "conversationIds"), Meta: requestMeta(request, options),
	})
	writeResult(response, http.StatusOK, map[string]any{"session": result}, err)
}

func denyBotSetupSession(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Bots) {
		return
	}
	result, err := options.Bots.DenySetupSession(request.Context(), bots.DenySetupInput{ActorID: actor.ID, SetupID: chi.URLParam(request, "sessionId"), Meta: requestMeta(request, options)})
	writeResult(response, http.StatusOK, map[string]any{"session": result}, err)
}

func pauseBot(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Bots) {
		return
	}
	transitionBot(response, request, actor, options, options.Bots.PauseBot)
}

func resumeBot(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Bots) {
		return
	}
	transitionBot(response, request, actor, options, options.Bots.ResumeBot)
}

func beginDeleteBot(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Bots) {
		return
	}
	transitionBot(response, request, actor, options, options.Bots.BeginDeleteBot)
}

func finalizeDeleteBot(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Bots) {
		return
	}
	transitionBot(response, request, actor, options, options.Bots.FinalizeDeleteBot)
}

func transitionBot(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions, transition func(context.Context, bots.TransitionInput) (bots.Bot, error)) {
	if missingService(response, options.Bots) {
		return
	}
	result, err := transition(request.Context(), bots.TransitionInput{ActorID: actor.ID, BotID: chi.URLParam(request, "botId"), Meta: requestMeta(request, options)})
	writeResult(response, http.StatusOK, map[string]any{"bot": result}, err)
}

func botGetInput(request *http.Request, actor *auth.Actor, options RouterOptions) bots.GetInput {
	return bots.GetInput{ActorID: actor.ID, BotID: chi.URLParam(request, "botId"), Meta: requestMeta(request, options)}
}

func requireBotFields(response http.ResponseWriter, request *http.Request, options RouterOptions, allowEmpty bool) (map[string]json.RawMessage, bool) {
	if missingService(response, options.Bots) {
		return nil, false
	}
	if !allowEmpty {
		fields, ok := decodeObjectFields(response, request, "bot.invalid_request")
		return fields, ok
	}
	var raw json.RawMessage
	if err := decodeJSON(response, request, &raw); err != nil {
		writeError(response, err)
		return nil, false
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return map[string]json.RawMessage{}, true
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(trimmed, &fields); err != nil || fields == nil {
		writeError(response, invalidBotRequest())
		return nil, false
	}
	return fields, true
}

func invalidBotRequest() *publicError {
	return &publicError{Code: "bot.invalid_request", Message: "请求参数无效", StatusCode: http.StatusBadRequest}
}

func onlyBotFields(fields map[string]json.RawMessage, allowed ...string) bool {
	known := make(map[string]struct{}, len(allowed))
	for _, key := range allowed {
		known[key] = struct{}{}
	}
	for key := range fields {
		if _, ok := known[key]; !ok {
			return false
		}
	}
	return true
}

func requiredBotString(fields map[string]json.RawMessage, key string) bool {
	raw, ok := fields[key]
	if !ok {
		return false
	}
	var value string
	return json.Unmarshal(raw, &value) == nil
}

func optionalBotBool(fields map[string]json.RawMessage, key string) (*bool, bool) {
	raw, ok := fields[key]
	if !ok {
		return nil, true
	}
	var value bool
	if json.Unmarshal(raw, &value) != nil {
		return nil, false
	}
	return &value, true
}

func optionalBotInt(fields map[string]json.RawMessage, key string) (*int, bool) {
	if _, present := fields[key]; !present {
		return nil, true
	}
	value, ok := objectFieldInt64(fields, key)
	if !ok {
		return nil, false
	}
	converted := int(value)
	if int64(converted) != value {
		return nil, false
	}
	return &converted, true
}

func optionalBotStringSlice(fields map[string]json.RawMessage, key string, minimum, maximum int) bool {
	raw, ok := fields[key]
	if !ok {
		return true
	}
	var value []string
	if json.Unmarshal(raw, &value) != nil || value == nil || len(value) < minimum || len(value) > maximum {
		return false
	}
	return true
}

func optionalBotNullableString(fields map[string]json.RawMessage, key string) bool {
	raw, ok := fields[key]
	if !ok || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return true
	}
	var value string
	return json.Unmarshal(raw, &value) == nil
}
