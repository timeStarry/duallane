package httpapi

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/conversations"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/members"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/messages"
)

type optional[T any] struct {
	Set   bool
	Value *T
}

func (value *optional[T]) UnmarshalJSON(data []byte) error {
	value.Set = true
	if string(data) == "null" {
		value.Value = nil
		return nil
	}
	var decoded T
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}
	value.Value = &decoded
	return nil
}

type profileRequest struct {
	Nickname           optional[string] `json:"nickname"`
	SearchDiscoverable optional[bool]   `json:"searchDiscoverable"`
	RecallReason       optional[string] `json:"recallReason"`
}

type remarkRequest struct {
	Remark string `json:"remark"`
}

type visibilityRequest struct {
	VisibleUserIDs []string `json:"visibleUserIds"`
}

type roleRequest struct {
	Role string `json:"role"`
}

type conversationCreateRequest struct {
	Type         string           `json:"type"`
	TargetUserID string           `json:"targetUserId"`
	Title        string           `json:"title"`
	MemberIDs    []string         `json:"memberIds"`
	AvatarEmoji  optional[string] `json:"avatarEmoji"`
}

type conversationMemberRequest struct {
	UserID string `json:"userId"`
}

type conversationUpdateRequest struct {
	Title       optional[string] `json:"title"`
	AvatarEmoji optional[string] `json:"avatarEmoji"`
}

type notificationRequest struct {
	Level             string `json:"level"`
	NotificationLevel string `json:"notificationLevel"`
}

type pinRequest struct {
	MessageID string `json:"messageId"`
}

type messageCreateRequest struct {
	ConversationID   string           `json:"conversationId"`
	ClientMessageID  string           `json:"clientMessageId"`
	Content          messages.Content `json:"content"`
	ReplyToMessageID string           `json:"replyToMessageId"`
}

type reactionRequest struct {
	EmoteKey string `json:"emoteKey"`
}

func registerCoreRoutes(router chi.Router, options RouterOptions) {
	router.Get("/statistics", withActor(options, getStatistics))
	router.Get("/conversations", withActor(options, listConversations))
	router.Get("/conversations/{conversationId}", withActor(options, getConversation))
	router.Get("/members", withActor(options, listMembers))
	router.Patch("/me/profile", withActor(options, updateOwnProfile))
	router.Put("/members/{userId}/remark", withActor(options, updateMemberRemark))
	router.Delete("/members/{userId}/remark", withActor(options, removeMemberRemark))
	router.Get("/member-visibility/{userId}", withActor(options, getMemberVisibility))
	router.Put("/member-visibility/{userId}", withActor(options, updateMemberVisibility))
	router.Patch("/members/{userId}/role", withActor(options, updateMemberRole))
	router.Delete("/members/{userId}", withActor(options, removeSpaceMember))
	router.Post("/conversations", withActor(options, createConversation))
	router.Post("/groups/{conversationId}/members", withActor(options, addConversationMember))
	router.Delete("/groups/{conversationId}/members/{userId}", withActor(options, removeConversationMember))
	router.Patch("/groups/{conversationId}", withActor(options, updateGroupConversation))
	router.Post("/groups/{conversationId}/leave", withActor(options, leaveConversation))
	router.Get("/conversations/{conversationId}/messages", withActor(options, listMessages))
	router.Get("/groups/{conversationId}/pins", withActor(options, listPins))
	router.Post("/groups/{conversationId}/pins", withActor(options, pinMessage))
	router.Delete("/groups/{conversationId}/pins/{messageId}", withActor(options, unpinMessage))
	router.Post("/conversations/{conversationId}/read", withActor(options, markConversationRead))
	router.Patch("/conversations/{conversationId}/notification", withActor(options, updateConversationNotification))
	router.Post("/messages", withActor(options, createMessage))
	router.Post("/messages/{messageId}/recall", withActor(options, recallMessage))
	router.Put("/messages/{messageId}/hidden", withActor(options, hideMessage))
	router.Delete("/messages/{messageId}/hidden", withActor(options, unhideMessage))
	router.Post("/messages/{messageId}/reactions", withActor(options, addReaction))
	router.Delete("/messages/{messageId}/reactions/{emoteKey}", withActor(options, removeReaction))
}

func getStatistics(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Overview) {
		return
	}
	statistics, err := options.Overview.GetStatistics(request.Context(), actor.ID, requestMeta(request, options))
	writeResult(response, http.StatusOK, map[string]any{"statistics": statistics}, err)
}

type actorHandler func(http.ResponseWriter, *http.Request, *auth.Actor, RouterOptions)

func withActor(options RouterOptions, handler actorHandler) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		actor, ok := resolveActor(response, request, options.ActorResolver)
		if !ok {
			return
		}
		handler(response, request, actor, options)
	}
}

func requestMeta(request *http.Request, options RouterOptions) auth.RequestMeta {
	return auth.RequestMetaFromRequest(request, options.TrustProxy)
}

func parseLimit(raw string) int {
	value, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || value <= 0 {
		return 0
	}
	return value
}

func missingService(response http.ResponseWriter, service any) bool {
	if service != nil {
		return false
	}
	writeError(response, internalError())
	return true
}

func decodeBody(response http.ResponseWriter, request *http.Request, target any) bool {
	if err := decodeJSON(response, request, target); err != nil {
		writeError(response, err)
		return false
	}
	return true
}

func writeResult(response http.ResponseWriter, status int, value any, err error) {
	if err != nil {
		writeError(response, err)
		return
	}
	writeJSON(response, status, value)
}

func listConversations(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Conversations) {
		return
	}
	items, err := options.Conversations.ListConversations(request.Context(), actor.ID, requestMeta(request, options))
	writeResult(response, http.StatusOK, map[string]any{"conversations": items}, err)
}

func getConversation(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Conversations) {
		return
	}
	item, err := options.Conversations.GetConversation(request.Context(), conversations.ConversationInput{ActorID: actor.ID, ConversationID: chi.URLParam(request, "conversationId"), Meta: requestMeta(request, options)})
	writeResult(response, http.StatusOK, map[string]any{"conversation": item}, err)
}

func listMembers(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Members) {
		return
	}
	query := request.URL.Query()
	items, err := options.Members.List(request.Context(), members.ListInput{ActorID: actor.ID, Options: members.ListOptions{Query: query.Get("q"), Role: query.Get("role"), Kind: query.Get("kind"), Limit: parseLimit(query.Get("limit"))}, Meta: requestMeta(request, options)})
	writeResult(response, http.StatusOK, map[string]any{"members": items}, err)
}

func updateOwnProfile(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Members) {
		return
	}
	var body profileRequest
	if !decodeBody(response, request, &body) {
		return
	}
	item, err := options.Members.UpdateOwnProfile(request.Context(), members.UpdateOwnProfileInput{ActorID: actor.ID, Nickname: body.Nickname.Value, NicknameSet: body.Nickname.Set, SearchDiscoverable: body.SearchDiscoverable.Value, SearchDiscoverableSet: body.SearchDiscoverable.Set, RecallReason: body.RecallReason.Value, RecallReasonSet: body.RecallReason.Set, Meta: requestMeta(request, options)})
	writeResult(response, http.StatusOK, map[string]any{"user": item}, err)
}

func updateMemberRemark(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Members) {
		return
	}
	var body remarkRequest
	if !decodeBody(response, request, &body) {
		return
	}
	item, err := options.Members.UpdateMemberRemark(request.Context(), members.RemarkInput{ActorID: actor.ID, UserID: chi.URLParam(request, "userId"), Remark: body.Remark, Meta: requestMeta(request, options)})
	writeResult(response, http.StatusOK, map[string]any{"member": item}, err)
}

func removeMemberRemark(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Members) {
		return
	}
	item, err := options.Members.RemoveMemberRemark(request.Context(), members.RemarkInput{ActorID: actor.ID, UserID: chi.URLParam(request, "userId"), Meta: requestMeta(request, options)})
	writeResult(response, http.StatusOK, map[string]any{"member": item}, err)
}

func getMemberVisibility(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Members) {
		return
	}
	item, err := options.Members.GetVisibility(request.Context(), members.VisibilityReadInput{ActorID: actor.ID, ViewerUserID: chi.URLParam(request, "userId"), Meta: requestMeta(request, options)})
	writeResult(response, http.StatusOK, map[string]any{"visibility": item}, err)
}

func updateMemberVisibility(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Members) {
		return
	}
	var body visibilityRequest
	if !decodeBody(response, request, &body) {
		return
	}
	item, err := options.Members.UpdateVisibility(request.Context(), members.VisibilityInput{ActorID: actor.ID, ViewerUserID: chi.URLParam(request, "userId"), VisibleUserIDs: body.VisibleUserIDs, Meta: requestMeta(request, options)})
	writeResult(response, http.StatusOK, map[string]any{"visibility": item}, err)
}

func updateMemberRole(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Members) {
		return
	}
	var body roleRequest
	if !decodeBody(response, request, &body) {
		return
	}
	item, err := options.Members.UpdateMemberRole(request.Context(), members.RoleInput{ActorID: actor.ID, UserID: chi.URLParam(request, "userId"), Role: body.Role, Meta: requestMeta(request, options)})
	writeResult(response, http.StatusOK, map[string]any{"member": item}, err)
}

func removeSpaceMember(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Members) {
		return
	}
	item, err := options.Members.RemoveMember(request.Context(), members.RemoveInput{ActorID: actor.ID, UserID: chi.URLParam(request, "userId"), Meta: requestMeta(request, options)})
	writeResult(response, http.StatusOK, item, err)
}

func createConversation(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Conversations) {
		return
	}
	var body conversationCreateRequest
	if !decodeBody(response, request, &body) {
		return
	}
	item, err := options.Conversations.CreateConversation(request.Context(), conversations.CreateConversationInput{ActorID: actor.ID, Type: body.Type, TargetUserID: body.TargetUserID, Title: body.Title, MemberIDs: body.MemberIDs, AvatarEmoji: body.AvatarEmoji.Value, AvatarEmojiSet: body.AvatarEmoji.Set, Meta: requestMeta(request, options)})
	writeResult(response, http.StatusCreated, map[string]any{"conversation": item}, err)
}

func addConversationMember(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Conversations) {
		return
	}
	var body conversationMemberRequest
	if !decodeBody(response, request, &body) {
		return
	}
	item, err := options.Conversations.AddMember(request.Context(), conversations.ConversationMemberInput{ActorID: actor.ID, ConversationID: chi.URLParam(request, "conversationId"), UserID: body.UserID, Meta: requestMeta(request, options)})
	writeResult(response, http.StatusCreated, map[string]any{"conversation": item}, err)
}

func removeConversationMember(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Conversations) {
		return
	}
	item, err := options.Conversations.RemoveMember(request.Context(), conversations.ConversationMemberInput{ActorID: actor.ID, ConversationID: chi.URLParam(request, "conversationId"), UserID: chi.URLParam(request, "userId"), Meta: requestMeta(request, options)})
	writeResult(response, http.StatusOK, map[string]any{"conversation": item}, err)
}

func updateGroupConversation(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Conversations) {
		return
	}
	var body conversationUpdateRequest
	if !decodeBody(response, request, &body) {
		return
	}
	item, err := options.Conversations.UpdateGroup(request.Context(), conversations.UpdateGroupInput{ActorID: actor.ID, ConversationID: chi.URLParam(request, "conversationId"), Title: body.Title.Value, TitleSet: body.Title.Set, AvatarEmoji: body.AvatarEmoji.Value, AvatarEmojiSet: body.AvatarEmoji.Set, Meta: requestMeta(request, options)})
	writeResult(response, http.StatusOK, map[string]any{"conversation": item}, err)
}

func leaveConversation(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Conversations) {
		return
	}
	result, err := options.Conversations.Leave(request.Context(), conversations.ConversationInput{ActorID: actor.ID, ConversationID: chi.URLParam(request, "conversationId"), Meta: requestMeta(request, options)})
	writeResult(response, http.StatusOK, result, err)
}

func listMessages(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Messages) {
		return
	}
	query := request.URL.Query()
	items, err := options.Messages.List(request.Context(), messages.ListOptions{ActorID: actor.ID, ConversationID: chi.URLParam(request, "conversationId"), Before: query.Get("before"), After: query.Get("after"), Around: query.Get("around"), Limit: parseLimit(query.Get("limit")), Meta: requestMeta(request, options)})
	writeResult(response, http.StatusOK, map[string]any{"messages": items}, err)
}

func listPins(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Conversations) {
		return
	}
	items, err := options.Conversations.ListPins(request.Context(), conversations.ConversationInput{ActorID: actor.ID, ConversationID: chi.URLParam(request, "conversationId"), Meta: requestMeta(request, options)})
	writeResult(response, http.StatusOK, map[string]any{"pins": items}, err)
}

func pinMessage(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Conversations) {
		return
	}
	var body pinRequest
	if !decodeBody(response, request, &body) {
		return
	}
	item, err := options.Conversations.Pin(request.Context(), conversations.PinInput{ActorID: actor.ID, ConversationID: chi.URLParam(request, "conversationId"), MessageID: body.MessageID, Meta: requestMeta(request, options)})
	writeResult(response, http.StatusCreated, map[string]any{"pin": item}, err)
}

func unpinMessage(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Conversations) {
		return
	}
	item, err := options.Conversations.Unpin(request.Context(), conversations.PinInput{ActorID: actor.ID, ConversationID: chi.URLParam(request, "conversationId"), MessageID: chi.URLParam(request, "messageId"), Meta: requestMeta(request, options)})
	writeResult(response, http.StatusOK, item, err)
}

func markConversationRead(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Conversations) {
		return
	}
	item, err := options.Conversations.MarkRead(request.Context(), conversations.ConversationInput{ActorID: actor.ID, ConversationID: chi.URLParam(request, "conversationId"), Meta: requestMeta(request, options)})
	writeResult(response, http.StatusOK, map[string]any{"conversation": item}, err)
}

func updateConversationNotification(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Conversations) {
		return
	}
	var body notificationRequest
	if !decodeBody(response, request, &body) {
		return
	}
	item, err := options.Conversations.UpdateNotification(request.Context(), conversations.NotificationInput{ActorID: actor.ID, ConversationID: chi.URLParam(request, "conversationId"), Level: body.Level, NotificationLevel: body.NotificationLevel, Meta: requestMeta(request, options)})
	writeResult(response, http.StatusOK, map[string]any{"conversation": item}, err)
}

func createMessage(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Messages) {
		return
	}
	var body messageCreateRequest
	if !decodeBody(response, request, &body) {
		return
	}
	item, err := options.Messages.Create(request.Context(), messages.CreateInput{ActorID: actor.ID, ConversationID: body.ConversationID, ClientMessageID: body.ClientMessageID, Content: body.Content, ReplyToMessageID: body.ReplyToMessageID, Meta: requestMeta(request, options)})
	writeResult(response, http.StatusCreated, map[string]any{"message": item}, err)
}

func recallMessage(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Messages) {
		return
	}
	item, err := options.Messages.Recall(request.Context(), messages.RecallInput{ActorID: actor.ID, MessageID: chi.URLParam(request, "messageId"), Meta: requestMeta(request, options)})
	writeResult(response, http.StatusOK, map[string]any{"message": item}, err)
}

func hideMessage(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	setMessageHidden(response, request, actor, options, true)
}

func unhideMessage(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	setMessageHidden(response, request, actor, options, false)
}

func setMessageHidden(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions, hidden bool) {
	if missingService(response, options.Messages) {
		return
	}
	input := messages.HideInput{ActorID: actor.ID, MessageID: chi.URLParam(request, "messageId"), Meta: requestMeta(request, options)}
	var result messages.HideResult
	var err error
	if hidden {
		result, err = options.Messages.Hide(request.Context(), input)
	} else {
		result, err = options.Messages.Unhide(request.Context(), input)
	}
	writeResult(response, http.StatusOK, result, err)
}

func addReaction(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Messages) {
		return
	}
	var body reactionRequest
	if !decodeBody(response, request, &body) {
		return
	}
	result, err := options.Messages.AddReaction(request.Context(), messages.ReactionInput{ActorID: actor.ID, MessageID: chi.URLParam(request, "messageId"), EmoteKey: body.EmoteKey, Meta: requestMeta(request, options)})
	status := http.StatusOK
	if result.Created {
		status = http.StatusCreated
	}
	writeResult(response, status, map[string]any{"messageId": result.MessageID, "reactions": result.Reactions}, err)
}

func removeReaction(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Messages) {
		return
	}
	emoteKey := chi.URLParam(request, "emoteKey")
	// Chi matches RawPath when present; otherwise net/http already decoded Path.
	// Unconditionally unescaping would decode literal percent sequences twice.
	if request.URL.RawPath != "" {
		decoded, err := url.PathUnescape(emoteKey)
		if err != nil {
			writeError(response, messages.NewError(messages.CodeReactionInvalidEmote, messages.MessageReactionInvalidEmote, http.StatusBadRequest))
			return
		}
		emoteKey = decoded
	}
	result, err := options.Messages.RemoveReaction(request.Context(), messages.ReactionInput{ActorID: actor.ID, MessageID: chi.URLParam(request, "messageId"), EmoteKey: emoteKey, Meta: requestMeta(request, options)})
	writeResult(response, http.StatusOK, map[string]any{"messageId": result.MessageID, "reactions": result.Reactions}, err)
}
