package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/conversations"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/gate"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/members"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/messages"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/overview"
)

type fakeMemberService struct {
	profileInput members.UpdateOwnProfileInput
	profile      members.Member
	err          error
}

func (service *fakeMemberService) List(context.Context, members.ListInput) ([]members.Member, error) {
	return []members.Member{service.profile}, service.err
}

func (service *fakeMemberService) UpdateOwnProfile(_ context.Context, input members.UpdateOwnProfileInput) (members.Member, error) {
	service.profileInput = input
	return service.profile, service.err
}

func (service *fakeMemberService) UpdateMemberRemark(context.Context, members.RemarkInput) (members.Member, error) {
	return service.profile, service.err
}

func (service *fakeMemberService) RemoveMemberRemark(context.Context, members.RemarkInput) (members.Member, error) {
	return service.profile, service.err
}

func (service *fakeMemberService) GetVisibility(context.Context, members.VisibilityReadInput) (members.VisibilityRule, error) {
	return members.VisibilityRule{}, service.err
}

func (service *fakeMemberService) UpdateVisibility(context.Context, members.VisibilityInput) (members.VisibilityRule, error) {
	return members.VisibilityRule{}, service.err
}

func (service *fakeMemberService) UpdateMemberRole(context.Context, members.RoleInput) (members.Member, error) {
	return service.profile, service.err
}

func (service *fakeMemberService) RemoveMember(context.Context, members.RemoveInput) (members.RemoveResult, error) {
	return members.RemoveResult{OK: true}, service.err
}

type fakeConversationService struct {
	createInput conversations.CreateConversationInput
	created     conversations.Conversation
	err         error
}

func (service *fakeConversationService) ListConversations(context.Context, string, auth.RequestMeta) ([]conversations.Conversation, error) {
	return []conversations.Conversation{service.created}, service.err
}

func (service *fakeConversationService) GetConversation(context.Context, conversations.ConversationInput) (conversations.Conversation, error) {
	return service.created, service.err
}

func (service *fakeConversationService) CreateConversation(_ context.Context, input conversations.CreateConversationInput) (conversations.Conversation, error) {
	service.createInput = input
	return service.created, service.err
}

func (service *fakeConversationService) AddMember(context.Context, conversations.ConversationMemberInput) (conversations.Conversation, error) {
	return service.created, service.err
}

func (service *fakeConversationService) RemoveMember(context.Context, conversations.ConversationMemberInput) (conversations.Conversation, error) {
	return service.created, service.err
}

func (service *fakeConversationService) UpdateGroup(context.Context, conversations.UpdateGroupInput) (conversations.Conversation, error) {
	return service.created, service.err
}

func (service *fakeConversationService) Leave(context.Context, conversations.ConversationInput) (conversations.LeaveResult, error) {
	return conversations.LeaveResult{OK: true}, service.err
}

func (service *fakeConversationService) MarkRead(context.Context, conversations.ConversationInput) (conversations.Conversation, error) {
	return service.created, service.err
}

func (service *fakeConversationService) UpdateNotification(context.Context, conversations.NotificationInput) (conversations.Conversation, error) {
	return service.created, service.err
}

func (service *fakeConversationService) ListPins(context.Context, conversations.ConversationInput) ([]conversations.PinListItem, error) {
	return []conversations.PinListItem{}, service.err
}

func (service *fakeConversationService) Pin(context.Context, conversations.PinInput) (conversations.PinListItem, error) {
	return conversations.PinListItem{}, service.err
}

func (service *fakeConversationService) Unpin(context.Context, conversations.PinInput) (conversations.UnpinResult, error) {
	return conversations.UnpinResult{}, service.err
}

type fakeMessageService struct {
	createInput messages.CreateInput
	reaction    messages.ReactionResult
	err         error
}

type fakeOverviewService struct {
	statistics overview.Statistics
	actorID    string
	meta       auth.RequestMeta
	err        error
}

func (service *fakeOverviewService) GetStatistics(_ context.Context, actorID string, meta auth.RequestMeta) (overview.Statistics, error) {
	service.actorID = actorID
	service.meta = meta
	return service.statistics, service.err
}

func (service *fakeMessageService) List(context.Context, messages.ListOptions) ([]messages.Message, error) {
	return []messages.Message{}, service.err
}

func (service *fakeMessageService) Create(_ context.Context, input messages.CreateInput) (messages.Message, error) {
	service.createInput = input
	return messages.Message{ID: "message-1"}, service.err
}

func (service *fakeMessageService) Recall(context.Context, messages.RecallInput) (messages.Message, error) {
	return messages.Message{}, service.err
}

func (service *fakeMessageService) Hide(context.Context, messages.HideInput) (messages.HideResult, error) {
	return messages.HideResult{}, service.err
}

func (service *fakeMessageService) Unhide(context.Context, messages.HideInput) (messages.HideResult, error) {
	return messages.HideResult{}, service.err
}

func (service *fakeMessageService) AddReaction(context.Context, messages.ReactionInput) (messages.ReactionResult, error) {
	return service.reaction, service.err
}

func (service *fakeMessageService) RemoveReaction(context.Context, messages.ReactionInput) (messages.ReactionResult, error) {
	return service.reaction, service.err
}

func coreRouter(membersService MemberService, conversationsService ConversationService, messagesService MessageService) http.Handler {
	return NewRouter(RouterOptions{
		Gate:          gate.New("true"),
		ActorResolver: &fakeResolver{actor: &auth.Actor{ID: "owner", Kind: "human", Role: "owner"}},
		Members:       membersService,
		Conversations: conversationsService,
		Messages:      messagesService,
		TrustProxy:    true,
	})
}

func TestProfileRoutePreservesOmittedAndExplicitNullFields(t *testing.T) {
	service := &fakeMemberService{profile: members.Member{ID: "owner", Kind: "human", Role: "owner"}}
	router := coreRouter(service, nil, nil)
	request := httptest.NewRequest(http.MethodPatch, "/api/workspace/me/profile", strings.NewReader(`{"nickname":null,"searchDiscoverable":false}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Request-ID", "profile-request")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
	}
	input := service.profileInput
	if !input.NicknameSet || input.Nickname != nil || !input.SearchDiscoverableSet || input.SearchDiscoverable == nil || *input.SearchDiscoverable || input.RecallReasonSet {
		t.Fatalf("profile presence flags = %#v", input)
	}
	if input.ActorID != "owner" || input.Meta.RequestID != "profile-request" {
		t.Fatalf("profile actor/meta = %#v", input)
	}
}

func TestCreateConversationAndMessageKeepLegacyResponseShapes(t *testing.T) {
	conversationService := &fakeConversationService{created: conversations.Conversation{ID: "conversation-1", Type: "group"}}
	messageService := &fakeMessageService{}
	router := coreRouter(nil, conversationService, messageService)

	request := httptest.NewRequest(http.MethodPost, "/api/workspace/conversations", strings.NewReader(`{"type":"group","title":"Group","memberIds":["member-1"],"avatarEmoji":null}`))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusCreated || !strings.Contains(response.Body.String(), `"conversation":{"id":"conversation-1"`) {
		t.Fatalf("conversation response = %d %s", response.Code, response.Body.String())
	}
	if !conversationService.createInput.AvatarEmojiSet || conversationService.createInput.AvatarEmoji != nil {
		t.Fatalf("avatar presence = %#v", conversationService.createInput)
	}

	request = httptest.NewRequest(http.MethodPost, "/api/workspace/messages", strings.NewReader(`{"conversationId":"conversation-1","clientMessageId":"client-1","content":{"format":"duallane.message+json;v=1","blocks":[{"type":"text","text":"hello"}]}}`))
	request.Header.Set("Content-Type", "application/json")
	response = httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusCreated || !strings.Contains(response.Body.String(), `"message":{"id":"message-1"`) {
		t.Fatalf("message response = %d %s", response.Code, response.Body.String())
	}
	if messageService.createInput.ActorID != "owner" || messageService.createInput.ConversationID != "conversation-1" || messageService.createInput.Content.Blocks[0].Text != "hello" {
		t.Fatalf("message input = %#v", messageService.createInput)
	}
}

func TestReactionCreationAndDomainErrorsKeepStatusCodes(t *testing.T) {
	messageService := &fakeMessageService{reaction: messages.ReactionResult{MessageID: "message-1", Created: true, Reactions: []messages.ReactionGroup{}}}
	router := coreRouter(nil, nil, messageService)
	request := httptest.NewRequest(http.MethodPost, "/api/workspace/messages/message-1/reactions", strings.NewReader(`{"emoteKey":"builtin:wave"}`))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("reaction status = %d body=%s", response.Code, response.Body.String())
	}

	messageService.err = messages.NewError(messages.CodeMessageNotFound, messages.MessageNotFound, http.StatusNotFound)
	response = httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/workspace/messages/message-1/recall", nil))
	if response.Code != http.StatusNotFound {
		t.Fatalf("message error mapping = %d body=%s", response.Code, response.Body.String())
	}
	var payload map[string]map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload["error"]["code"] != messages.CodeMessageNotFound {
		t.Fatalf("message error payload = %#v", payload)
	}
}

func TestRegisteredCoreRoutesAreNotTransportNotFound(t *testing.T) {
	router := coreRouter(&fakeMemberService{}, &fakeConversationService{}, &fakeMessageService{})
	checks := []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/api/workspace/members"},
		{http.MethodGet, "/api/workspace/conversations"},
		{http.MethodGet, "/api/workspace/conversations/conversation-1/messages"},
		{http.MethodPost, "/api/workspace/groups/conversation-1/leave"},
		{http.MethodDelete, "/api/workspace/messages/message-1/hidden"},
	}
	for _, check := range checks {
		response := httptest.NewRecorder()
		router.ServeHTTP(response, httptest.NewRequest(check.method, check.path, nil))
		if response.Code == http.StatusNotFound || response.Code == http.StatusMethodNotAllowed {
			t.Fatalf("%s %s was not registered: %d", check.method, check.path, response.Code)
		}
	}
}

func TestStatisticsRouteWrapsProjectionAndMapsOverviewErrors(t *testing.T) {
	service := &fakeOverviewService{statistics: overview.Statistics{AsOf: "2026-09-04T00:00:00.000Z", Totals: overview.Counts{Members: 3}}}
	router := NewRouter(RouterOptions{Gate: gate.New("true"), ActorResolver: &fakeResolver{actor: &auth.Actor{ID: "owner"}}, Overview: service, TrustProxy: true})
	request := httptest.NewRequest(http.MethodGet, "/api/workspace/statistics", nil)
	request.Header.Set("X-Request-ID", "statistics-request")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"statistics":{"asOf":"2026-09-04T00:00:00.000Z"`) {
		t.Fatalf("statistics response = %d %s", response.Code, response.Body.String())
	}
	if service.actorID != "owner" || service.meta.RequestID != "statistics-request" {
		t.Fatalf("statistics input = actor:%q meta:%#v", service.actorID, service.meta)
	}

	service.err = overview.NewError(overview.CodePermissionDenied, overview.MessagePermissionDenied, http.StatusForbidden)
	response = httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden || !strings.Contains(response.Body.String(), `"code":"permission.denied"`) {
		t.Fatalf("statistics error = %d %s", response.Code, response.Body.String())
	}
}
