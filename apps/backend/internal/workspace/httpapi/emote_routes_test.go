package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"strings"
	"testing"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/emotes"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/gate"
)

type emoteRoutesStub struct {
	settingsInput  emotes.UpdateSettingsInput
	uploadInput    emotes.UploadInput
	favoriteInput  emotes.FavoriteFromMessageInput
	favoriteResult *emotes.CustomEmote
	importInput    emotes.ImportShareInput
	reorderInput   emotes.ReorderInput
	reorderResult  emotes.PublicLibrary
	content        []byte
	err            error
	favoriteErr    error
	favoriteCalls  int
	checkedLength  int64
}

func (s *emoteRoutesStub) CheckUploadLength(_ context.Context, _ string, length int64, _ auth.RequestMeta) error {
	s.checkedLength = length
	return emotes.NewError(emotes.CodeEmoteInputTooLarge, emotes.MessageEmoteInputTooLarge, http.StatusRequestEntityTooLarge)
}

func (*emoteRoutesStub) GetSettings(context.Context, string) (emotes.EmoteSettings, error) {
	return emotes.EmoteSettings{
		EnabledPackIDs: []string{"builtin"}, AutoHideMessageTypes: []string{"image", "emote", "long"}, MinimumEnabled: 1,
	}, nil
}
func (s *emoteRoutesStub) UpdateSettings(_ context.Context, _ string, input emotes.UpdateSettingsInput, _ auth.RequestMeta) (emotes.EmoteSettings, error) {
	s.settingsInput = input
	return emotes.EmoteSettings{EnabledPackIDs: []string{"builtin"}}, s.err
}
func (*emoteRoutesStub) List(context.Context, string) ([]emotes.CustomEmote, emotes.EmoteUsage, emotes.EmoteLimits, error) {
	return []emotes.CustomEmote{{ID: "emote-1", Label: "Wave"}}, emotes.EmoteUsage{ItemCount: 1}, emotes.EmoteLimits{MaxInputBytes: emotes.MaxInputBytes}, nil
}
func (*emoteRoutesStub) GetLibrary(context.Context, string) (emotes.PublicLibrary, error) {
	return emotes.PublicLibrary{Entries: []emotes.PublicLibraryEntry{}, Emotes: []emotes.CustomEmote{}, Collections: []emotes.Collection{}}, nil
}
func (s *emoteRoutesStub) Upload(_ context.Context, input emotes.UploadInput) (*emotes.CustomEmote, error) {
	s.uploadInput = input
	content, err := io.ReadAll(input.Content)
	if err != nil {
		return nil, err
	}
	s.content = content
	return &emotes.CustomEmote{ID: "uploaded", Label: "Upload"}, s.err
}
func (s *emoteRoutesStub) FavoriteFromMessage(_ context.Context, input emotes.FavoriteFromMessageInput) (*emotes.CustomEmote, error) {
	s.favoriteCalls++
	s.favoriteInput = input
	if s.favoriteResult == nil {
		s.favoriteResult = &emotes.CustomEmote{ID: "favorite", Kind: "custom", Label: "Favorite"}
	}
	return s.favoriteResult, s.favoriteErr
}
func (*emoteRoutesStub) CreateBuiltinFavorite(context.Context, string, string, auth.RequestMeta) (*emotes.CustomEmote, error) {
	return &emotes.CustomEmote{ID: "favorite"}, nil
}
func (*emoteRoutesStub) CreateCollection(context.Context, emotes.CreateCollectionInput) (emotes.Collection, error) {
	return emotes.Collection{ID: "collection-1"}, nil
}
func (*emoteRoutesStub) UpdateCollection(context.Context, emotes.UpdateCollectionInput) (emotes.Collection, error) {
	return emotes.Collection{ID: "collection-1"}, nil
}
func (*emoteRoutesStub) UpdateCollectionSourceSubscription(context.Context, string, string, bool, auth.RequestMeta) error {
	return nil
}
func (*emoteRoutesStub) DeleteCollection(context.Context, emotes.DeleteCollectionInput) (map[string]any, error) {
	return map[string]any{"ok": true}, nil
}
func (*emoteRoutesStub) AddCollectionItems(context.Context, emotes.CollectionItemsInput) (emotes.Collection, error) {
	return emotes.Collection{ID: "collection-1"}, nil
}
func (*emoteRoutesStub) RemoveCollectionItem(context.Context, emotes.RemoveCollectionItemInput) (emotes.Collection, error) {
	return emotes.Collection{ID: "collection-1"}, nil
}
func (*emoteRoutesStub) ReorderLibrary(context.Context, emotes.ReorderInput) (emotes.PublicLibrary, error) {
	return emotes.PublicLibrary{}, nil
}
func (s *emoteRoutesStub) ReorderEmotes(_ context.Context, input emotes.ReorderInput) (emotes.PublicLibrary, error) {
	s.reorderInput = input
	return s.reorderResult, s.err
}
func (*emoteRoutesStub) ReorderCollection(context.Context, emotes.ReorderInput, string) (emotes.Collection, error) {
	return emotes.Collection{ID: "collection-1"}, nil
}
func (*emoteRoutesStub) Update(context.Context, emotes.UpdateEmoteInput) (*emotes.CustomEmote, error) {
	return &emotes.CustomEmote{ID: "emote-1"}, nil
}
func (*emoteRoutesStub) Remove(context.Context, string, string, auth.RequestMeta) (map[string]any, error) {
	return map[string]any{"ok": true}, nil
}
func (s *emoteRoutesStub) ReadContent(context.Context, emotes.ReadContentInput) (emotes.Delivery, error) {
	if s.err != nil {
		return emotes.Delivery{}, s.err
	}
	return emotes.Delivery{Body: io.NopCloser(bytes.NewReader(s.content)), ContentType: "image/webp", ByteSize: int64(len(s.content))}, nil
}
func (*emoteRoutesStub) CreateShare(context.Context, emotes.CreateShareInput) (emotes.Share, error) {
	return emotes.Share{ID: "share-1"}, nil
}
func (*emoteRoutesStub) GetShare(context.Context, string, string) (emotes.Share, error) {
	return emotes.Share{ID: "share-1"}, nil
}
func (*emoteRoutesStub) RevokeShare(context.Context, emotes.ShareInput) (emotes.Share, error) {
	return emotes.Share{ID: "share-1"}, nil
}
func (s *emoteRoutesStub) ImportShare(_ context.Context, input emotes.ImportShareInput) (emotes.ImportShareResult, error) {
	s.importInput = input
	return emotes.ImportShareResult{Items: []emotes.CustomEmote{}}, s.err
}

func emoteRoutesRouter(service emoteService) http.Handler {
	return NewRouter(RouterOptions{
		Gate: gate.New("true"), ActorResolver: &fakeResolver{actor: &auth.Actor{ID: "actor-1", Kind: "human", Role: "member"}},
		Emotes: service, TrustProxy: true,
	})
}

func TestEmoteSettingsListAndUploadContracts(t *testing.T) {
	service := &emoteRoutesStub{}
	router := emoteRoutesRouter(service)

	list := httptest.NewRecorder()
	router.ServeHTTP(list, httptest.NewRequest(http.MethodGet, "/api/workspace/me/emotes", nil))
	if list.Code != http.StatusOK || !strings.Contains(list.Body.String(), `"items":[{"id":"emote-1"`) || !strings.Contains(list.Body.String(), `"maxInputBytes":10485760`) {
		t.Fatalf("list status=%d body=%s", list.Code, list.Body.String())
	}

	click := true
	request := httptest.NewRequest(http.MethodPut, "/api/workspace/me/emote-settings", strings.NewReader(`{"clickImageEmoteToSend":true}`))
	request.Header.Set("Content-Type", "application/json")
	settings := httptest.NewRecorder()
	router.ServeHTTP(settings, request)
	if settings.Code != http.StatusOK || service.settingsInput.ClickImageEmoteToSend == nil || *service.settingsInput.ClickImageEmoteToSend != click || service.settingsInput.EnabledPackIDs != nil {
		t.Fatalf("settings status=%d input=%#v", settings.Code, service.settingsInput)
	}

	upload := httptest.NewRecorder()
	request = httptest.NewRequest(http.MethodPost, "/api/workspace/me/emotes?collectionId=collection-1&addToLibrary=false", strings.NewReader("image bytes"))
	request.Header.Set("Content-Type", "image/png; charset=binary")
	request.Header.Set("X-DualLane-File-Name", "%E8%A1%A8%E6%83%85%2B1.png")
	router.ServeHTTP(upload, request)
	if upload.Code != http.StatusCreated || service.uploadInput.ActorID != "actor-1" || service.uploadInput.CollectionID != "collection-1" || service.uploadInput.AddToLibrary || service.uploadInput.Source.FileName != "表情+1.png" || service.uploadInput.Source.MIMEType != "image/png" || string(service.content) != "image bytes" {
		t.Fatalf("upload status=%d input=%#v content=%q body=%s", upload.Code, service.uploadInput, service.content, upload.Body.String())
	}
}

func TestEmoteSettingsAutoHideRouteRejectsInvalidJSONTypes(t *testing.T) {
	for _, body := range []string{
		`{"autoHideMessages":null}`,
		`{"autoHideMessages":"yes"}`,
		`{"autoHideMessageTypes":null}`,
		`{"autoHideMessageTypes":["image",null]}`,
		`{"autoHideMessageTypes":["image",7]}`,
	} {
		t.Run(body, func(t *testing.T) {
			service := &emoteRoutesStub{}
			request := httptest.NewRequest(http.MethodPut, "/api/workspace/me/emote-settings", strings.NewReader(body))
			request.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()
			emoteRoutesRouter(service).ServeHTTP(response, request)
			if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), `"code":"`+emotes.CodeEmoteInvalidSettings+`"`) {
				t.Fatalf("invalid settings response = %d %s", response.Code, response.Body.String())
			}
			if service.settingsInput.AutoHideMessages != nil || service.settingsInput.AutoHideMessageTypes != nil {
				t.Fatalf("invalid settings reached service = %#v", service.settingsInput)
			}
		})
	}
}

func TestEmoteSettingsAutoHideRoutePassesPartialValues(t *testing.T) {
	service := &emoteRoutesStub{}
	request := httptest.NewRequest(http.MethodPut, "/api/workspace/me/emote-settings", strings.NewReader(`{"autoHideMessages":true,"autoHideMessageTypes":["image","image","long"]}`))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	emoteRoutesRouter(service).ServeHTTP(response, request)
	if response.Code != http.StatusOK || service.settingsInput.AutoHideMessages == nil || !*service.settingsInput.AutoHideMessages || service.settingsInput.AutoHideMessageTypes == nil {
		t.Fatalf("partial settings response = %d input=%#v body=%s", response.Code, service.settingsInput, response.Body.String())
	}
	if strings.Join(*service.settingsInput.AutoHideMessageTypes, ",") != "image,image,long" {
		t.Fatalf("route should preserve input for service normalization = %#v", service.settingsInput)
	}
}

func TestListEmotesMatchesNodeFixtureTopLevelEnvelope(t *testing.T) {
	fixturePath := nodeEmoteFixturePath(t)
	fixtureBytes, err := os.ReadFile(fixturePath)
	if err != nil {
		t.Fatalf("read Node emote fixture %q: %v", fixturePath, err)
	}
	var fixture struct {
		Scenarios []struct {
			Name     string `json:"name"`
			Response struct {
				Status int             `json:"status"`
				Body   json.RawMessage `json:"body"`
			} `json:"response"`
		} `json:"scenarios"`
	}
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatalf("decode Node emote fixture: %v", err)
	}

	var expectedStatus int
	var expectedBody map[string]json.RawMessage
	for _, scenario := range fixture.Scenarios {
		if scenario.Name != "emote-list" {
			continue
		}
		expectedStatus = scenario.Response.Status
		if err := json.Unmarshal(scenario.Response.Body, &expectedBody); err != nil {
			t.Fatalf("decode Node emote-list response: %v", err)
		}
		break
	}
	if expectedStatus == 0 || expectedBody == nil {
		t.Fatal("Node emote fixture has no emote-list response")
	}
	expectedKeys := sortedJSONKeys(expectedBody)

	response := httptest.NewRecorder()
	emoteRoutesRouter(&emoteRoutesStub{}).ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/workspace/me/emotes", nil))
	if response.Code != expectedStatus {
		t.Fatalf("list status=%d, want Node fixture status=%d body=%s", response.Code, expectedStatus, response.Body.String())
	}
	var actualBody map[string]json.RawMessage
	if err := json.Unmarshal(response.Body.Bytes(), &actualBody); err != nil {
		t.Fatalf("decode Go emote-list response: %v", err)
	}
	if actualKeys := sortedJSONKeys(actualBody); !reflect.DeepEqual(actualKeys, expectedKeys) {
		t.Fatalf("Go emote-list top-level keys=%v, want Node fixture keys=%v; body=%s", actualKeys, expectedKeys, response.Body.String())
	}
	if _, ok := actualBody["emotes"]; ok {
		t.Fatalf("Go emote-list response contains non-canonical emotes field: %s", response.Body.String())
	}
}

func TestReorderEmotesMatchesNodeFixtureTopLevelEnvelope(t *testing.T) {
	fixturePath := nodeEmoteFixturePath(t)
	fixtureBytes, err := os.ReadFile(fixturePath)
	if err != nil {
		t.Fatalf("read Node emote fixture %q: %v", fixturePath, err)
	}
	var fixture struct {
		Scenarios []struct {
			Name    string `json:"name"`
			Request struct {
				Method string          `json:"method"`
				Path   string          `json:"path"`
				Body   json.RawMessage `json:"body"`
			} `json:"request"`
			Response struct {
				Status int             `json:"status"`
				Body   json.RawMessage `json:"body"`
			} `json:"response"`
		} `json:"scenarios"`
	}
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatalf("decode Node emote fixture: %v", err)
	}

	var scenario struct {
		Name    string
		Request struct {
			Method string
			Path   string
			Body   json.RawMessage
		}
		Response struct {
			Status int
			Body   json.RawMessage
		}
	}
	for _, candidate := range fixture.Scenarios {
		if candidate.Name == "emote-reorder" {
			scenario.Name = candidate.Name
			scenario.Request.Method = candidate.Request.Method
			scenario.Request.Path = candidate.Request.Path
			scenario.Request.Body = candidate.Request.Body
			scenario.Response.Status = candidate.Response.Status
			scenario.Response.Body = candidate.Response.Body
			break
		}
	}
	if scenario.Name == "" {
		t.Fatal("Node emote fixture has no emote-reorder response")
	}

	var expectedEnvelope struct {
		Items  []emotes.CustomEmote `json:"items"`
		Usage  emotes.EmoteUsage    `json:"usage"`
		Limits emotes.EmoteLimits   `json:"limits"`
	}
	if err := json.Unmarshal(scenario.Response.Body, &expectedEnvelope); err != nil {
		t.Fatalf("decode Node emote-reorder response: %v", err)
	}
	var expectedBody map[string]any
	if err := json.Unmarshal(scenario.Response.Body, &expectedBody); err != nil {
		t.Fatalf("decode Node emote-reorder response map: %v", err)
	}

	service := &emoteRoutesStub{reorderResult: emotes.PublicLibrary{
		Emotes: expectedEnvelope.Items,
		Usage:  expectedEnvelope.Usage,
		Limits: expectedEnvelope.Limits,
	}}
	request := httptest.NewRequest(scenario.Request.Method, scenario.Request.Path, bytes.NewReader(scenario.Request.Body))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	emoteRoutesRouter(service).ServeHTTP(response, request)

	if response.Code != scenario.Response.Status {
		t.Fatalf("reorder status=%d, want Node fixture status=%d body=%s", response.Code, scenario.Response.Status, response.Body.String())
	}
	var actualBody map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &actualBody); err != nil {
		t.Fatalf("decode Go emote-reorder response: %v", err)
	}
	if actualKeys := sortedJSONKeys(rawJSONMap(response.Body.Bytes(), t)); !reflect.DeepEqual(actualKeys, sortedJSONKeys(rawJSONMap(scenario.Response.Body, t))) {
		t.Fatalf("Go emote-reorder top-level keys=%v, want Node fixture keys=%v; body=%s", actualKeys, sortedJSONKeys(rawJSONMap(scenario.Response.Body, t)), response.Body.String())
	}
	if !reflect.DeepEqual(actualBody, expectedBody) {
		t.Fatalf("Go emote-reorder body=%s, want Node fixture body=%s", response.Body.String(), string(scenario.Response.Body))
	}
	if _, ok := actualBody["emotes"]; ok {
		t.Fatalf("Go emote-reorder response contains non-canonical emotes field: %s", response.Body.String())
	}
	if _, ok := actualBody["entries"]; ok {
		t.Fatalf("Go emote-reorder response contains library-only entries field: %s", response.Body.String())
	}
	if !reflect.DeepEqual(service.reorderInput.IDs, []string{"emote_builtin_01", "emote_custom_01"}) {
		t.Fatalf("reorder input IDs=%v, want fixture order", service.reorderInput.IDs)
	}
}

func rawJSONMap(body []byte, t *testing.T) map[string]json.RawMessage {
	t.Helper()
	var values map[string]json.RawMessage
	if err := json.Unmarshal(body, &values); err != nil {
		t.Fatalf("decode JSON object: %v", err)
	}
	return values
}

func nodeEmoteFixturePath(t *testing.T) string {
	t.Helper()
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	return filepath.Join(filepath.Dir(sourceFile), "..", "..", "workspacecontract", "testdata", "node-emotes.json")
}

func sortedJSONKeys(values map[string]json.RawMessage) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func TestFavoriteEmotePassesEverySourceActorAndSafeRequestMeta(t *testing.T) {
	tests := []struct {
		name       string
		body       string
		messageID  string
		attachment string
		emoteKey   string
		customID   string
	}{
		{name: "builtin", body: `{"messageId":"msg-builtin","emoteKey":" bili:doge "}`, messageID: "msg-builtin", emoteKey: " bili:doge "},
		{name: "attachment", body: `{"messageId":"msg-attachment","attachmentId":"att-1"}`, messageID: "msg-attachment", attachment: "att-1"},
		{name: "custom", body: `{"messageId":"msg-custom","customEmoteId":"11111111-1111-1111-1111-111111111111"}`, messageID: "msg-custom", customID: "11111111-1111-1111-1111-111111111111"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			service := &emoteRoutesStub{}
			router := NewRouter(RouterOptions{
				Gate: gate.New("true"), ActorResolver: &fakeResolver{actor: &auth.Actor{ID: "actor-1", Kind: "human", Role: "member"}},
				Emotes: service, TrustProxy: true,
			})
			request := httptest.NewRequest(http.MethodPost, "/api/workspace/me/emotes/favorite", strings.NewReader(test.body))
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("X-Request-ID", "favorite-route-request")
			request.Header.Set("X-Forwarded-For", "198.51.100.8, 10.0.0.1")
			request.Header.Set("User-Agent", "favorite-route-test")
			response := httptest.NewRecorder()

			router.ServeHTTP(response, request)
			if response.Code != http.StatusCreated || !strings.Contains(response.Body.String(), `"id":"favorite"`) {
				t.Fatalf("favorite response = %d %s", response.Code, response.Body.String())
			}
			input := service.favoriteInput
			if service.favoriteCalls != 1 || input.ActorID != "actor-1" || input.MessageID != test.messageID {
				t.Fatalf("favorite invocation = calls:%d input:%#v", service.favoriteCalls, input)
			}
			if input.AttachmentID != test.attachment || input.EmoteKey != test.emoteKey || input.CustomEmoteID != test.customID {
				t.Fatalf("favorite source input = %#v", input)
			}
			if input.Meta.RequestID != "favorite-route-request" || input.Meta.IPAddress != "198.51.100.8" || input.Meta.UserAgent != "favorite-route-test" {
				t.Fatalf("favorite request meta = %#v", input.Meta)
			}
		})
	}
}

func TestFavoriteEmotePassesInvalidMultipleSourceToDomain(t *testing.T) {
	service := &emoteRoutesStub{favoriteErr: emotes.NewError(emotes.CodeEmoteInvalidSource, emotes.MessageEmoteInvalidSource, http.StatusBadRequest)}
	router := NewRouter(RouterOptions{
		Gate: gate.New("true"), ActorResolver: &fakeResolver{actor: &auth.Actor{ID: "actor-1", Kind: "human", Role: "member"}}, Emotes: service,
	})
	request := httptest.NewRequest(http.MethodPost, "/api/workspace/me/emotes/favorite", strings.NewReader(`{"messageId":"msg-multi","attachmentId":"att-1","emoteKey":"bili:doge","customEmoteId":"11111111-1111-1111-1111-111111111111"}`))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), `"code":"`+emotes.CodeEmoteInvalidSource+`"`) || service.favoriteCalls != 1 {
		t.Fatalf("invalid multiple source = status:%d calls:%d body:%s", response.Code, service.favoriteCalls, response.Body.String())
	}
	if service.favoriteInput.AttachmentID != "att-1" || service.favoriteInput.EmoteKey != "bili:doge" || service.favoriteInput.CustomEmoteID == "" {
		t.Fatalf("invalid multiple source was rewritten = %#v", service.favoriteInput)
	}
}

func TestFavoriteEmoteProjectsDomainErrorsWithoutLeakingCause(t *testing.T) {
	for _, test := range []struct {
		name   string
		status int
		code   string
		msg    string
	}{
		{name: "message missing", status: http.StatusNotFound, code: "message.not_found", msg: "消息不存在"},
		{name: "permission removed", status: http.StatusForbidden, code: emotes.CodePermissionDenied, msg: emotes.MessagePermissionDenied},
		{name: "source too large", status: http.StatusRequestEntityTooLarge, code: emotes.CodeEmoteSourceTooLarge, msg: emotes.MessageEmoteSourceTooLarge},
	} {
		t.Run(test.name, func(t *testing.T) {
			service := &emoteRoutesStub{favoriteErr: &emotes.Error{
				Code: test.code, Message: test.msg, StatusCode: test.status,
				Cause: errors.New("private filesystem path and sha256 secret"),
			}}
			router := NewRouter(RouterOptions{
				Gate: gate.New("true"), ActorResolver: &fakeResolver{actor: &auth.Actor{ID: "actor-1", Kind: "human", Role: "member"}}, Emotes: service,
			})
			request := httptest.NewRequest(http.MethodPost, "/api/workspace/me/emotes/favorite", strings.NewReader(`{"messageId":"msg-error","attachmentId":"att-error"}`))
			request.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			body := response.Body.String()
			if response.Code != test.status || service.favoriteCalls != 1 || !strings.Contains(body, `"code":"`+test.code+`"`) || !strings.Contains(body, test.msg) {
				t.Fatalf("domain error = status:%d calls:%d body:%s", response.Code, service.favoriteCalls, body)
			}
			if strings.Contains(body, "private filesystem") || strings.Contains(body, "sha256 secret") {
				t.Fatalf("domain error leaked cause: %s", body)
			}
		})
	}
}

func TestFavoriteEmoteHonorsGateAndAuthBeforeService(t *testing.T) {
	service := &emoteRoutesStub{}
	resolver := &fakeResolver{actor: &auth.Actor{ID: "actor-1", Kind: "human", Role: "member"}}
	disabled := NewRouter(RouterOptions{Gate: gate.New("false"), ActorResolver: resolver, Emotes: service})
	request := httptest.NewRequest(http.MethodPost, "/api/workspace/me/emotes/favorite", strings.NewReader(`{"messageId":"secret-message","attachmentId":"secret-attachment"}`))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	disabled.ServeHTTP(response, request)
	if response.Code != http.StatusServiceUnavailable || resolver.calls != 0 || service.favoriteCalls != 0 || strings.Contains(response.Body.String(), "secret-message") {
		t.Fatalf("disabled favorite = status:%d resolver:%d calls:%d body:%s", response.Code, resolver.calls, service.favoriteCalls, response.Body.String())
	}

	unauthenticated := NewRouter(RouterOptions{Gate: gate.New("true"), Emotes: service})
	response = httptest.NewRecorder()
	unauthenticated.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/workspace/me/emotes/favorite", strings.NewReader(`{"messageId":"msg-unauth","emoteKey":"bili:doge"}`)))
	if response.Code != http.StatusUnauthorized || !strings.Contains(response.Body.String(), `"code":"auth.required"`) || service.favoriteCalls != 0 {
		t.Fatalf("unauthenticated favorite = status:%d calls:%d body:%s", response.Code, service.favoriteCalls, response.Body.String())
	}
}

func TestEmoteUploadBoundsAndContentIsPrivate(t *testing.T) {
	service := &emoteRoutesStub{content: []byte("webp")}
	router := emoteRoutesRouter(service)
	tooLarge := httptest.NewRequest(http.MethodPost, "/api/workspace/me/emotes", strings.NewReader("ignored"))
	tooLarge.ContentLength = emotes.MaxInputBytes + 1
	response := httptest.NewRecorder()
	router.ServeHTTP(response, tooLarge)
	if response.Code != http.StatusRequestEntityTooLarge || !strings.Contains(response.Body.String(), emotes.CodeEmoteInputTooLarge) {
		t.Fatalf("large upload status=%d body=%s", response.Code, response.Body.String())
	}
	if service.checkedLength != emotes.MaxInputBytes+1 || service.uploadInput.ActorID != "" {
		t.Fatal("overage did not use the domain rejection preflight before upload")
	}

	response = httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/workspace/emotes/emote-1/content", nil))
	if response.Code != http.StatusOK || response.Body.String() != "webp" || response.Header().Get("Content-Type") != "image/webp" || response.Header().Get("Cache-Control") != "private, max-age=31536000, immutable" {
		t.Fatalf("content status=%d headers=%v body=%q", response.Code, response.Header(), response.Body.String())
	}
}

func TestEmoteShareImportPreservesSubscriptionIntent(t *testing.T) {
	service := &emoteRoutesStub{}
	router := emoteRoutesRouter(service)
	request := httptest.NewRequest(http.MethodPost, "/api/workspace/emote-collection-shares/share-1/import", strings.NewReader(`{"emoteIds":["emote-1"],"asCollection":true,"collectionName":"Team","subscribeToSourceChanges":true}`))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusOK || service.importInput.ActorID != "actor-1" || service.importInput.ShareID != "share-1" || service.importInput.AsCollection == nil || !*service.importInput.AsCollection || !service.importInput.SubscribeToSourceChanges {
		t.Fatalf("import status=%d input=%#v body=%s", response.Code, service.importInput, response.Body.String())
	}
}
