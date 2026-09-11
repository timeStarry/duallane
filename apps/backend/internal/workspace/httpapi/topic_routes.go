package httpapi

import (
	"context"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/topics"
)

type topicService interface {
	List(context.Context, topics.ListInput) ([]topics.Topic, error)
	Create(context.Context, topics.CreateInput) (topics.Topic, error)
	GetSummary(context.Context, topics.TopicInput) (topics.Topic, error)
	Join(context.Context, topics.TopicInput) (topics.Topic, error)
	Leave(context.Context, topics.TopicInput) (topics.Topic, error)
	Close(context.Context, topics.TransitionInput) (topics.Topic, error)
	Archive(context.Context, topics.TransitionInput) (topics.Topic, error)
	ListMessages(context.Context, topics.MessageListInput) ([]topics.TopicMessage, error)
	CreateMessage(context.Context, topics.CreateMessageInput) (topics.TopicMessageResult, error)
	MarkRead(context.Context, topics.ReadInput) (topics.ReadResult, error)
	ListMembers(context.Context, topics.TopicInput) ([]topics.TopicMember, error)
	UpdateNotification(context.Context, topics.NotificationInput) (topics.Topic, error)
	SyncMessage(context.Context, topics.SyncInput) (topics.ProjectionResult, error)
	UnsyncMessage(context.Context, topics.SyncInput) (topics.ProjectionResult, error)
	ListProjections(context.Context, topics.ProjectionListInput) ([]topics.Projection, error)
}

type topicCreateRequest struct {
	Title            string `json:"title"`
	Description      string `json:"description"`
	Source           string `json:"source"`
	IdempotencyKey   string `json:"idempotencyKey"`
	AllowSyncToGroup bool   `json:"allowSyncToGroup"`
}

type topicMessageRequest struct {
	ClientMessageID  string         `json:"clientMessageId"`
	Content          topics.Content `json:"content"`
	Body             string         `json:"body"`
	ReplyToMessageID string         `json:"replyToMessageId"`
	SyncToGroup      bool           `json:"syncToGroup"`
}

type topicReadRequest struct {
	MessageID string `json:"messageId"`
}

type topicNotificationRequest struct {
	Level             string `json:"level"`
	NotificationLevel string `json:"notificationLevel"`
}

type topicTransitionRequest struct {
	ExpectedRevision int64 `json:"expectedRevision"`
}

func registerTopicRoutes(router chi.Router, options RouterOptions) {
	router.Get("/topics/mine", withActor(options, listOwnTopics))
	router.Get("/topics", withActor(options, listTopics))
	router.Get("/conversations/{conversationId}/topics", withActor(options, listConversationTopics))
	router.Post("/conversations/{conversationId}/topics", withActor(options, createTopic))
	router.Get("/topics/{topicId}/messages", withActor(options, listTopicMessages))
	router.Post("/topics/{topicId}/messages", withActor(options, createTopicMessage))
	router.Post("/topics/{topicId}/read", withActor(options, markTopicRead))
	router.Get("/topics/{topicId}/members", withActor(options, listTopicMembers))
	router.Patch("/topics/{topicId}/notification", withActor(options, updateTopicNotification))
	router.Post("/topics/{topicId}/messages/{messageId}/sync", withActor(options, syncTopicMessage))
	router.Delete("/topics/{topicId}/messages/{messageId}/sync", withActor(options, unsyncTopicMessage))
	router.Get("/topics/{topicId}/projections", withActor(options, listTopicProjections))
	router.Get("/topics/{topicId}", withActor(options, getTopic))
	router.Post("/topics/{topicId}/join", withActor(options, joinTopic))
	router.Post("/topics/{topicId}/leave", withActor(options, leaveTopic))
	router.Post("/topics/{topicId}/close", withActor(options, closeTopic))
	router.Post("/topics/{topicId}/archive", withActor(options, archiveTopic))
}

func listOwnTopics(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	listTopicsWith(response, request, actor, options, "", true)
}

func listTopics(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	mine, ok := topicBooleanQuery(response, request.URL.Query().Get("mine"))
	if ok {
		listTopicsWith(response, request, actor, options, "", mine)
	}
}

func listConversationTopics(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	mine, ok := topicBooleanQuery(response, request.URL.Query().Get("mine"))
	if ok {
		listTopicsWith(response, request, actor, options, chi.URLParam(request, "conversationId"), mine)
	}
}

func listTopicsWith(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions, conversationID string, mine bool) {
	if missingService(response, options.Topics) {
		return
	}
	result, err := options.Topics.List(request.Context(), topics.ListInput{
		ActorID: actor.ID, ConversationID: conversationID, Status: request.URL.Query().Get("status"), Mine: mine,
		Limit: parseLimit(request.URL.Query().Get("limit")), Meta: requestMeta(request, options),
	})
	writeResult(response, http.StatusOK, map[string]any{"topics": result}, err)
}

func createTopic(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Topics) {
		return
	}
	var body topicCreateRequest
	if !decodeBody(response, request, &body) {
		return
	}
	result, err := options.Topics.Create(request.Context(), topics.CreateInput{
		ActorID: actor.ID, ConversationID: chi.URLParam(request, "conversationId"), Title: body.Title,
		Description: body.Description, Source: body.Source, IdempotencyKey: body.IdempotencyKey,
		AllowSyncToGroup: body.AllowSyncToGroup, Meta: requestMeta(request, options),
	})
	writeResult(response, http.StatusCreated, map[string]any{"topic": result}, err)
}

func getTopic(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Topics) {
		return
	}
	result, err := options.Topics.GetSummary(request.Context(), topicInput(request, actor, options))
	writeResult(response, http.StatusOK, map[string]any{"topic": result}, err)
}

func joinTopic(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	mutateTopicMembership(response, request, actor, options, true)
}

func leaveTopic(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	mutateTopicMembership(response, request, actor, options, false)
}

func mutateTopicMembership(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions, join bool) {
	if missingService(response, options.Topics) {
		return
	}
	input := topicInput(request, actor, options)
	var result topics.Topic
	var err error
	if join {
		result, err = options.Topics.Join(request.Context(), input)
	} else {
		result, err = options.Topics.Leave(request.Context(), input)
	}
	writeResult(response, http.StatusOK, map[string]any{"topic": result}, err)
}

func closeTopic(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	transitionTopic(response, request, actor, options, false)
}

func archiveTopic(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	transitionTopic(response, request, actor, options, true)
}

func transitionTopic(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions, archive bool) {
	if missingService(response, options.Topics) {
		return
	}
	var body topicTransitionRequest
	if !decodeBody(response, request, &body) {
		return
	}
	input := topics.TransitionInput{ActorID: actor.ID, TopicID: chi.URLParam(request, "topicId"), ExpectedRevision: body.ExpectedRevision, Meta: requestMeta(request, options)}
	var result topics.Topic
	var err error
	if archive {
		result, err = options.Topics.Archive(request.Context(), input)
	} else {
		result, err = options.Topics.Close(request.Context(), input)
	}
	writeResult(response, http.StatusOK, map[string]any{"topic": result}, err)
}

func listTopicMessages(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Topics) {
		return
	}
	query := request.URL.Query()
	result, err := options.Topics.ListMessages(request.Context(), topics.MessageListInput{
		ActorID: actor.ID, TopicID: chi.URLParam(request, "topicId"), Before: query.Get("before"), After: query.Get("after"),
		Around: query.Get("around"),
		Limit:  parseLimit(query.Get("limit")), Meta: requestMeta(request, options),
	})
	writeResult(response, http.StatusOK, map[string]any{"messages": result}, err)
}

func createTopicMessage(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Topics) {
		return
	}
	var body topicMessageRequest
	if !decodeBody(response, request, &body) {
		return
	}
	result, err := options.Topics.CreateMessage(request.Context(), topics.CreateMessageInput{
		ActorID: actor.ID, TopicID: chi.URLParam(request, "topicId"), ClientMessageID: body.ClientMessageID,
		Content: body.Content, Body: body.Body, ReplyToMessageID: body.ReplyToMessageID, SyncToGroup: body.SyncToGroup,
		Meta: requestMeta(request, options),
	})
	writeResult(response, http.StatusCreated, map[string]any{"message": result.Message, "unread": result.Unread}, err)
}

func markTopicRead(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Topics) {
		return
	}
	var body topicReadRequest
	if !decodeBody(response, request, &body) {
		return
	}
	result, err := options.Topics.MarkRead(request.Context(), topics.ReadInput{
		ActorID: actor.ID, TopicID: chi.URLParam(request, "topicId"), MessageID: body.MessageID, Meta: requestMeta(request, options),
	})
	writeResult(response, http.StatusOK, map[string]any{"read": result}, err)
}

func listTopicMembers(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Topics) {
		return
	}
	result, err := options.Topics.ListMembers(request.Context(), topicInput(request, actor, options))
	writeResult(response, http.StatusOK, map[string]any{"members": result}, err)
}

func updateTopicNotification(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Topics) {
		return
	}
	var body topicNotificationRequest
	if !decodeBody(response, request, &body) {
		return
	}
	result, err := options.Topics.UpdateNotification(request.Context(), topics.NotificationInput{
		ActorID: actor.ID, TopicID: chi.URLParam(request, "topicId"), Level: body.Level,
		NotificationLevel: body.NotificationLevel, Meta: requestMeta(request, options),
	})
	writeResult(response, http.StatusOK, map[string]any{"topic": result}, err)
}

func syncTopicMessage(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	mutateTopicProjection(response, request, actor, options, true)
}

func unsyncTopicMessage(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	mutateTopicProjection(response, request, actor, options, false)
}

func mutateTopicProjection(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions, sync bool) {
	if missingService(response, options.Topics) {
		return
	}
	input := topics.SyncInput{ActorID: actor.ID, TopicID: chi.URLParam(request, "topicId"), MessageID: chi.URLParam(request, "messageId"), Meta: requestMeta(request, options)}
	var result topics.ProjectionResult
	var err error
	if sync {
		result, err = options.Topics.SyncMessage(request.Context(), input)
	} else {
		result, err = options.Topics.UnsyncMessage(request.Context(), input)
	}
	status := http.StatusOK
	if sync {
		status = http.StatusCreated
	}
	writeResult(response, status, map[string]any{"projection": result.Projection}, err)
}

func listTopicProjections(response http.ResponseWriter, request *http.Request, actor *auth.Actor, options RouterOptions) {
	if missingService(response, options.Topics) {
		return
	}
	result, err := options.Topics.ListProjections(request.Context(), topics.ProjectionListInput{
		ActorID: actor.ID, TopicID: chi.URLParam(request, "topicId"), Limit: parseLimit(request.URL.Query().Get("limit")), Meta: requestMeta(request, options),
	})
	writeResult(response, http.StatusOK, map[string]any{"projections": result}, err)
}

func topicInput(request *http.Request, actor *auth.Actor, options RouterOptions) topics.TopicInput {
	return topics.TopicInput{ActorID: actor.ID, TopicID: chi.URLParam(request, "topicId"), Meta: requestMeta(request, options)}
}

func topicBooleanQuery(response http.ResponseWriter, raw string) (bool, bool) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "", "false", "0":
		return false, true
	case "true", "1":
		return true, true
	default:
		writeError(response, topics.NewError("topic.invalid_query", "查询参数无效", http.StatusBadRequest))
		return false, false
	}
}
