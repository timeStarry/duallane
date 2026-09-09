package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestBotGatewayCardRoutesPreserveFallbackJSONPresenceAndCodeUnits(t *testing.T) {
	cases := []struct {
		name        string
		raw         string
		wantPresent bool
	}{
		{name: "lone-surrogate", raw: `"\ud800 explicit"`, wantPresent: true},
		{name: "bom", raw: `"\ufeff  BOM  \ufeff"`, wantPresent: true},
		{name: "astral", raw: `"\ud83d\ude00 explicit"`, wantPresent: true},
		{name: "null", raw: "null", wantPresent: true},
		{name: "omitted", wantPresent: false},
	}
	for _, fixture := range cases {
		t.Run(fixture.name, func(t *testing.T) {
			gateway := &botGatewayRouteFake{}
			router := newBotGatewayRouteTestRouter(gateway, nil, true)
			body := `{"conversationId":"conv_1","clientMessageId":"msg_1","idempotencyKey":"idem_1","format":"feishu-card","feishuCard":{"elements":[{"tag":"div","text":{"tag":"plain_text","content":"body"}}]}`
			if fixture.wantPresent {
				body += `,"fallbackText":` + fixture.raw
			}
			body += `}`
			response := httptest.NewRecorder()
			router.ServeHTTP(response, gatewayJSONRequest(http.MethodPost, "/api/bot-gateway/v1/cards", body))
			if response.Code != http.StatusCreated {
				t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
			}
			if fixture.wantPresent {
				if string(gateway.cardInput.RawFallbackText) != fixture.raw {
					t.Fatalf("raw fallback = %s, want %s", gateway.cardInput.RawFallbackText, fixture.raw)
				}
			} else if gateway.cardInput.RawFallbackText != nil {
				t.Fatalf("omitted fallback raw = %s, want nil", gateway.cardInput.RawFallbackText)
			}
		})
	}

	gateway := &botGatewayRouteFake{}
	router := newBotGatewayRouteTestRouter(gateway, nil, true)
	raw := `"\ud800 update"`
	response := httptest.NewRecorder()
	router.ServeHTTP(response, gatewayJSONRequest(http.MethodPatch, "/api/bot-gateway/v1/cards/card_1", `{"format":"feishu-card","feishuCard":{"elements":[{"tag":"div","text":{"tag":"plain_text","content":"body"}}]},"fallbackText":`+raw+`}`))
	if response.Code != http.StatusOK {
		t.Fatalf("update status = %d, body = %s", response.Code, response.Body.String())
	}
	if string(gateway.updateCardInput.RawFallbackText) != raw {
		t.Fatalf("update raw fallback = %s, want %s", gateway.updateCardInput.RawFallbackText, raw)
	}
}
