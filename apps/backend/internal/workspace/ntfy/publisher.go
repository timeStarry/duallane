package ntfy

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const maximumProviderResponseBytes = 4 * 1024

type HTTPPublisherOptions struct {
	ServerURL string
	Client    *http.Client
	Timeout   time.Duration
}

type HTTPPublisher struct {
	serverURL string
	client    *http.Client
	timeout   time.Duration
	configErr error
}

func NewHTTPPublisher(options HTTPPublisherOptions) *HTTPPublisher {
	publisher, err := NewHTTPPublisherWithError(options)
	if err == nil {
		return publisher
	}
	return &HTTPPublisher{configErr: err}
}

func NewHTTPPublisherWithError(options HTTPPublisherOptions) (*HTTPPublisher, error) {
	serverURL, err := normalizeServerURL(options.ServerURL)
	if err != nil {
		return &HTTPPublisher{configErr: err}, err
	}
	timeout := options.Timeout
	if timeout <= 0 {
		timeout = DefaultPublishTimeout
	}
	client := options.Client
	if client == nil {
		client = &http.Client{}
	}
	// A provider must not be able to turn a failed response into an arbitrary
	// second outbound request. Preserve caller transport/timeouts while making
	// redirects fail closed.
	copyClient := *client
	copyClient.CheckRedirect = func(_ *http.Request, _ []*http.Request) error {
		return errors.New("ntfy provider redirect rejected")
	}
	return &HTTPPublisher{serverURL: serverURL, client: &copyClient, timeout: timeout}, nil
}

func (p *HTTPPublisher) Publish(ctx context.Context, input PublishInput) error {
	if p == nil || p.configErr != nil {
		if p == nil {
			return &ProviderError{}
		}
		return notConfiguredError(p.configErr)
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if err := validateNotification(input); err != nil {
		return err
	}
	body, err := json.Marshal(struct {
		Topic   string   `json:"topic"`
		Title   string   `json:"title"`
		Message string   `json:"message"`
		Click   string   `json:"click"`
		Tags    []string `json:"tags"`
	}{Topic: input.Topic, Title: input.Title, Message: input.Message, Click: input.ClickURL, Tags: []string{"speech_balloon"}})
	if err != nil {
		return &ProviderError{}
	}
	requestCtx, cancel := context.WithTimeout(ctx, p.timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodPost, p.serverURL, strings.NewReader(string(body)))
	if err != nil {
		return &ProviderError{}
	}
	request.Header.Set("content-type", "application/json")
	response, err := p.client.Do(request)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return &ProviderError{Timeout: true}
		}
		return &ProviderError{}
	}
	defer response.Body.Close()
	// The response body is never logged or returned. Read only a bounded amount
	// so keep-alive connections remain reusable without accepting large data.
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, maximumProviderResponseBytes))
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return &ProviderError{StatusCode: response.StatusCode}
	}
	return nil
}

func validateNotification(input Notification) error {
	if !validTopic(input.Topic) {
		return &ProviderError{}
	}
	if strings.TrimSpace(input.Title) == "" || strings.TrimSpace(input.Message) == "" {
		return &ProviderError{}
	}
	parsed, err := url.Parse(input.ClickURL)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return &ProviderError{}
	}
	return nil
}

func validTopic(value string) bool {
	if len(value) == 0 || len(value) > 256 {
		return false
	}
	for _, character := range value {
		if (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') ||
			(character >= '0' && character <= '9') || character == '-' || character == '_' {
			continue
		}
		return false
	}
	return true
}

func NormalizeProviderError(err error) string {
	return normalizeProviderError(err)
}
