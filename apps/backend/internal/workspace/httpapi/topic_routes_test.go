package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/gate"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/topics"
)

type fakeTopicRoutesService struct {
	listInput          topics.ListInput
	createInput        topics.CreateInput
	messageInput       topics.CreateMessageInput
	readInput          topics.ReadInput
	transitionInput    topics.TransitionInput
	syncInput          topics.SyncInput
	listCalls          int
	createMessageError error
}

func (service *fakeTopicRoutesService) List(_ context.Context, input topics.ListInput) ([]topics.Topic, error) {
	service.listInput = input
	service.listCalls++
	return []topics.Topic{{ID: "topic-1", Title: "Topic"}}, nil
}

func (service *fakeTopicRoutesService) Create(_ context.Context, input topics.CreateInput) (topics.Topic, error) {
	service.createInput = input
	return topics.Topic{ID: "topic-1", Title: input.Title}, nil
}

func (*fakeTopicRoutesService) GetSummary(_ context.Context, input topics.TopicInput) (topics.Topic, error) {
	return topics.Topic{ID: input.TopicID}, nil
}

func (*fakeTopicRoutesService) Join(_ context.Context, input topics.TopicInput) (topics.Topic, error) {
	return topics.Topic{ID: input.TopicID, Joined: true}, nil
}

func (*fakeTopicRoutesService) Leave(_ context.Context, input topics.TopicInput) (topics.Topic, error) {
	return topics.Topic{ID: input.TopicID}, nil
}

func (service *fakeTopicRoutesService) Close(_ context.Context, input topics.TransitionInput) (topics.Topic, error) {
	service.transitionInput = input
	return topics.Topic{ID: input.TopicID, Status: topics.StatusClosed}, nil
}

func (service *fakeTopicRoutesService) Archive(_ context.Context, input topics.TransitionInput) (topics.Topic, error) {
	service.transitionInput = input
	return topics.Topic{ID: input.TopicID, Status: topics.StatusArchived}, nil
}

func (*fakeTopicRoutesService) ListMessages(context.Context, topics.MessageListInput) ([]topics.TopicMessage, error) {
	return []topics.TopicMessage{}, nil
}

func (service *fakeTopicRoutesService) CreateMessage(_ context.Context, input topics.CreateMessageInput) (topics.TopicMessageResult, error) {
	service.messageInput = input
	if service.createMessageError != nil {
		return topics.TopicMessageResult{}, service.createMessageError
	}
	return topics.TopicMessageResult{Message: topics.TopicMessage{ID: "message-1", TopicID: input.TopicID}, Unread: 3}, nil
}

func (service *fakeTopicRoutesService) MarkRead(_ context.Context, input topics.ReadInput) (topics.ReadResult, error) {
	service.readInput = input
	return topics.ReadResult{TopicID: input.TopicID, UnreadCount: 0}, nil
}

func (*fakeTopicRoutesService) ListMembers(context.Context, topics.TopicInput) ([]topics.TopicMember, error) {
	return []topics.TopicMember{}, nil
}

func (*fakeTopicRoutesService) UpdateNotification(_ context.Context, input topics.NotificationInput) (topics.Topic, error) {
	return topics.Topic{ID: input.TopicID, NotificationLevel: input.NotificationLevel}, nil
}

func (service *fakeTopicRoutesService) SyncMessage(_ context.Context, input topics.SyncInput) (topics.ProjectionResult, error) {
	service.syncInput = input
	return topics.ProjectionResult{Projection: &topics.Projection{ID: "projection-1", TopicMessageID: input.MessageID}}, nil
}

func (service *fakeTopicRoutesService) UnsyncMessage(_ context.Context, input topics.SyncInput) (topics.ProjectionResult, error) {
	service.syncInput = input
	return topics.ProjectionResult{}, nil
}

func (*fakeTopicRoutesService) ListProjections(context.Context, topics.ProjectionListInput) ([]topics.Projection, error) {
	return []topics.Projection{}, nil
}

func topicRoutesRouter(service *fakeTopicRoutesService) http.Handler {
	return NewRouter(RouterOptions{
		Gate: gate.New("true"), ActorResolver: &fakeResolver{actor: &auth.Actor{ID: "owner", Kind: "human", Role: "owner"}},
		Topics: service, TrustProxy: true,
	})
}

func TestTopicRoutesPreserveStaticListAndCreateContracts(t *testing.T) {
	service := &fakeTopicRoutesService{}
	router := topicRoutesRouter(service)

	mine := httptest.NewRecorder()
	router.ServeHTTP(mine, httptest.NewRequest(http.MethodGet, "/api/workspace/topics/mine?status=open", nil))
	if mine.Code != http.StatusOK || !service.listInput.Mine || service.listInput.Status != topics.StatusOpen {
		t.Fatalf("mine status=%d input=%#v body=%s", mine.Code, service.listInput, mine.Body.String())
	}

	createRequest := httptest.NewRequest(http.MethodPost, "/api/workspace/conversations/group-1/topics", strings.NewReader(`{"title":"Release","description":"Ship it","allowSyncToGroup":true}`))
	createRequest.Header.Set("Content-Type", "application/json")
	createRequest.Header.Set("X-Request-ID", "topic-create")
	create := httptest.NewRecorder()
	router.ServeHTTP(create, createRequest)
	if create.Code != http.StatusCreated || service.createInput.ConversationID != "group-1" || !service.createInput.AllowSyncToGroup || service.createInput.Meta.RequestID != "topic-create" {
		t.Fatalf("create status=%d input=%#v body=%s", create.Code, service.createInput, create.Body.String())
	}

	invalid := httptest.NewRecorder()
	router.ServeHTTP(invalid, httptest.NewRequest(http.MethodGet, "/api/workspace/topics?mine=maybe", nil))
	if invalid.Code != http.StatusBadRequest || service.listCalls != 1 || !strings.Contains(invalid.Body.String(), "topic.invalid_query") {
		t.Fatalf("invalid status=%d calls=%d body=%s", invalid.Code, service.listCalls, invalid.Body.String())
	}
}

func TestTopicMessageReadAndProjectionRoutes(t *testing.T) {
	service := &fakeTopicRoutesService{}
	router := topicRoutesRouter(service)

	messageRequest := httptest.NewRequest(http.MethodPost, "/api/workspace/topics/topic-1/messages", strings.NewReader(`{"clientMessageId":"client-1","body":"hello","syncToGroup":true}`))
	messageRequest.Header.Set("Content-Type", "application/json")
	message := httptest.NewRecorder()
	router.ServeHTTP(message, messageRequest)
	if message.Code != http.StatusCreated || service.messageInput.TopicID != "topic-1" || !service.messageInput.SyncToGroup || !strings.Contains(message.Body.String(), `"unread":3`) {
		t.Fatalf("message status=%d input=%#v body=%s", message.Code, service.messageInput, message.Body.String())
	}

	readRequest := httptest.NewRequest(http.MethodPost, "/api/workspace/topics/topic-1/read", strings.NewReader(`{"messageId":"message-1"}`))
	readRequest.Header.Set("Content-Type", "application/json")
	read := httptest.NewRecorder()
	router.ServeHTTP(read, readRequest)
	if read.Code != http.StatusOK || service.readInput.MessageID != "message-1" {
		t.Fatalf("read status=%d input=%#v body=%s", read.Code, service.readInput, read.Body.String())
	}

	sync := httptest.NewRecorder()
	router.ServeHTTP(sync, httptest.NewRequest(http.MethodPost, "/api/workspace/topics/topic-1/messages/message-1/sync", strings.NewReader(`{}`)))
	if sync.Code != http.StatusCreated || service.syncInput.MessageID != "message-1" || !strings.Contains(sync.Body.String(), "projection-1") {
		t.Fatalf("sync status=%d input=%#v body=%s", sync.Code, service.syncInput, sync.Body.String())
	}
}

func TestTopicRoutesMapDomainErrorsAndRevision(t *testing.T) {
	service := &fakeTopicRoutesService{createMessageError: topics.NewError(topics.CodeTopicNotMember, topics.MessageTopicNotMember, http.StatusForbidden)}
	router := topicRoutesRouter(service)

	messageRequest := httptest.NewRequest(http.MethodPost, "/api/workspace/topics/topic-1/messages", strings.NewReader(`{"clientMessageId":"client-1","body":"hello"}`))
	messageRequest.Header.Set("Content-Type", "application/json")
	message := httptest.NewRecorder()
	router.ServeHTTP(message, messageRequest)
	if message.Code != http.StatusForbidden || !strings.Contains(message.Body.String(), topics.CodeTopicNotMember) {
		t.Fatalf("message status=%d body=%s", message.Code, message.Body.String())
	}

	closeRequest := httptest.NewRequest(http.MethodPost, "/api/workspace/topics/topic-1/close", strings.NewReader(`{"expectedRevision":7}`))
	closeRequest.Header.Set("Content-Type", "application/json")
	closeResponse := httptest.NewRecorder()
	router.ServeHTTP(closeResponse, closeRequest)
	if closeResponse.Code != http.StatusOK || service.transitionInput.ExpectedRevision != 7 {
		t.Fatalf("close status=%d input=%#v body=%s", closeResponse.Code, service.transitionInput, closeResponse.Body.String())
	}
}
