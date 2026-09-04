package email

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestSMTPMailerRejectsUnsafeConfigurationWithoutDialing(t *testing.T) {
	mailer := NewSMTPMailer(SMTPMailerOptions{Timeout: time.Millisecond})
	base := MailConfig{SMTPHost: "127.0.0.1", SMTPPort: 1, Encryption: "none", FromAddress: "sender@example.test", FromName: "DualLane"}
	for _, test := range []struct {
		name   string
		config MailConfig
		to     string
		want   string
	}{
		{name: "auth over plaintext", config: func() MailConfig {
			value := base
			value.Username = "sender@example.test"
			value.Password = "secret"
			return value
		}(), to: "to@example.test", want: CodeSMTPAuthFailed},
		{name: "recipient header injection", config: base, to: "to@example.test\r\nBcc: attacker@example.test", want: CodeSMTPFailed},
		{name: "host header injection", config: func() MailConfig { value := base; value.SMTPHost = "127.0.0.1\r\nX"; return value }(), to: "to@example.test", want: CodeSMTPFailed},
	} {
		t.Run(test.name, func(t *testing.T) {
			err := mailer.Send(context.Background(), test.config, Message{Subject: "test", Text: "body", HTML: "<p>body</p>"}, test.to)
			if !hasProviderCode(err, test.want) {
				t.Fatalf("error=%v, want %s", err, test.want)
			}
			if strings.Contains(err.Error(), "secret") {
				t.Fatal("provider error leaked credential")
			}
		})
	}
}

func TestBuildRFCMessageContainsOnlySafeTemplateFields(t *testing.T) {
	value := buildRFCMessage("DualLane <sender@example.test>", "to@example.test", Message{Subject: "DualLane：通知", Text: "没有正文", HTML: "<p>没有正文</p>"})
	if !strings.Contains(value, "multipart/alternative") || !strings.Contains(value, "没有正文") || !strings.Contains(value, "text/html") {
		t.Fatalf("message=%q", value)
	}
	if strings.Contains(value, "\nBcc:") || strings.Contains(value, "\nCc:") {
		t.Fatal("message contains an unexpected header")
	}
}

func hasProviderCode(err error, code string) bool {
	provider, ok := err.(*ProviderError)
	return ok && provider.Code == code
}
