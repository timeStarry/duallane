package ntfy

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestHTTPPublisherPostsSafeProjectionAndClassifiesStatus(t *testing.T) {
	var received Notification
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost || request.Header.Get("content-type") != "application/json" {
			t.Fatalf("request = %s %s content-type=%q", request.Method, request.URL, request.Header.Get("content-type"))
		}
		var payload struct {
			Topic, Title, Message, Click string
		}
		if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		received = Notification{Topic: payload.Topic, Title: payload.Title, Message: payload.Message, ClickURL: payload.Click}
		writer.WriteHeader(http.StatusAccepted)
		_, _ = writer.Write([]byte("provider body must not be returned"))
	}))
	defer server.Close()
	publisher, err := NewHTTPPublisherWithError(HTTPPublisherOptions{ServerURL: server.URL, Client: server.Client()})
	if err != nil {
		t.Fatal(err)
	}
	secret := "message body never belongs in ntfy"
	if err := publisher.Publish(context.Background(), Notification{Topic: "duallane-user-ABC123", Title: "DualLane", Message: "新消息", ClickURL: "https://duallane.example.test/workspace/chat/c-1"}); err != nil {
		t.Fatal(err)
	}
	if received.Topic != "duallane-user-ABC123" || received.Message == secret {
		t.Fatalf("received notification = %#v", received)
	}

	server.Config.Handler = http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusBadGateway)
		_, _ = writer.Write([]byte(secret))
	})
	if err := publisher.Publish(context.Background(), Notification{Topic: "duallane-user-ABC123", Title: "DualLane", Message: "新消息", ClickURL: "https://duallane.example.test"}); err == nil || NormalizeProviderError(err) != "ntfy.http_502" || strings.Contains(err.Error(), secret) {
		t.Fatalf("status error = %v", err)
	}
}

func TestHTTPPublisherRejectsUnsafeConfigurationAndRedirects(t *testing.T) {
	if _, err := NewHTTPPublisherWithError(HTTPPublisherOptions{ServerURL: "http://127.0.0.1:8080"}); err == nil {
		t.Fatal("HTTP provider URL unexpectedly accepted")
	}
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		http.Redirect(writer, request, "/other", http.StatusFound)
	}))
	defer server.Close()
	publisher, err := NewHTTPPublisherWithError(HTTPPublisherOptions{ServerURL: server.URL, Client: server.Client(), Timeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	err = publisher.Publish(context.Background(), Notification{Topic: "unsafe topic", Title: "title", Message: "message", ClickURL: "https://duallane.example.test"})
	if err == nil || NormalizeProviderError(err) != CodeProviderUnavailable {
		t.Fatalf("unsafe notification error = %v", err)
	}
}
