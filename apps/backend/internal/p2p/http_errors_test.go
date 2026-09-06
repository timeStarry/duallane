package p2p

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func TestRoomJSONErrorsPreserveSafeNodeParserContract(t *testing.T) {
	handler := NewHandler(HandlerOptions{})
	t.Cleanup(handler.Close)
	for _, test := range []struct {
		name, body, code, message string
		status                    int
	}{
		{"empty", "", "FST_ERR_CTP_EMPTY_JSON_BODY", "Body cannot be empty when content-type is set to 'application/json'", 400},
		{"whitespace", " \n", "FST_ERR_CTP_INVALID_JSON_BODY", "Body is not valid JSON but content-type is set to 'application/json'", 400},
		{"invalid", `{"private":"synthetic-sensitive-marker",`, "FST_ERR_CTP_INVALID_JSON_BODY", "Body is not valid JSON but content-type is set to 'application/json'", 400},
		{"trailing", `{"maxPeers":2}{}`, "FST_ERR_CTP_INVALID_JSON_BODY", "Body is not valid JSON but content-type is set to 'application/json'", 400},
		{"oversize", `{"maxPeers":2,"padding":"` + strings.Repeat("x", createRoomBodyLimit) + `"}`, "FST_ERR_CTP_BODY_TOO_LARGE", "Request body is too large", 413},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/api/p2p/rooms", strings.NewReader(test.body))
			request.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()
			handler.Routes().ServeHTTP(response, request)
			label := "Bad Request"
			if test.status == 413 {
				label = "Payload Too Large"
			}
			want := map[string]any{"statusCode": float64(test.status), "error": label, "code": test.code, "message": test.message}
			var got map[string]any
			if err := json.Unmarshal(response.Body.Bytes(), &got); err != nil {
				t.Fatal(err)
			}
			if response.Code != test.status || !reflect.DeepEqual(got, want) {
				t.Fatalf("safe parser contract mismatch: status=%d, keys/values=%v", response.Code, got)
			}
			if strings.Contains(response.Body.String(), "synthetic-sensitive-marker") {
				t.Fatal("parser error reflected request content")
			}
		})
	}
}

func TestValidJSONWithUnsupportedRoomShapeRetainsDomainError(t *testing.T) {
	handler := NewHandler(HandlerOptions{})
	t.Cleanup(handler.Close)
	for _, body := range []string{"null", "[]", "false", "2", `"2"`, "{}", `{"maxPeers":null}`, `{"maxPeers":3}`} {
		request := httptest.NewRequest(http.MethodPost, "/api/p2p/rooms", strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		handler.Routes().ServeHTTP(response, request)
		var got map[string]string
		if err := json.Unmarshal(response.Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		if response.Code != 400 || !reflect.DeepEqual(got, map[string]string{"error": "maxPeers must be 2 for p2p rooms"}) {
			t.Fatalf("valid JSON domain error changed for %s", body)
		}
	}
}
