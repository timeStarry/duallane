package email

import (
	"context"
	"crypto/tls"
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
		{name: "subject header injection", config: base, to: "to@example.test", want: CodeSMTPFailed},
		{name: "host header injection", config: func() MailConfig { value := base; value.SMTPHost = "127.0.0.1\r\nX"; return value }(), to: "to@example.test", want: CodeSMTPFailed},
	} {
		t.Run(test.name, func(t *testing.T) {
			subject := "test"
			if test.name == "subject header injection" {
				subject = "test\r\nBcc: attacker@example.test"
			}
			err := mailer.Send(context.Background(), test.config, Message{Subject: subject, Text: "body", HTML: "<p>body</p>"}, test.to)
			if !hasProviderCode(err, test.want) {
				t.Fatalf("error=%v, want %s", err, test.want)
			}
			if strings.Contains(err.Error(), "secret") {
				t.Fatal("provider error leaked credential")
			}
		})
	}
}

func TestSMTPMailerSendsCompleteMultipartMessage(t *testing.T) {
	server := newSyntheticSMTPServer(t, syntheticSMTPOptions{})
	config := syntheticMailConfig(server, "none")
	message := Message{Subject: "DualLane notification", Text: "plain body", HTML: "<p>html body</p>"}

	if err := NewSMTPMailer(SMTPMailerOptions{Timeout: time.Second}).Send(context.Background(), config, message, "recipient@example.test"); err != nil {
		t.Fatalf("Send() error = %v", err)
	}
	body, commands, _, _, _ := server.snapshot()
	for _, want := range []string{"Subject: DualLane", "plain body", "<p>html body</p>", "multipart/alternative"} {
		if !strings.Contains(body, want) {
			t.Fatalf("SMTP body missing %q: %q", want, body)
		}
	}
	if strings.Contains(strings.ToLower(body), "\r\nbcc:") || strings.Contains(strings.ToLower(body), "\r\ncc:") {
		t.Fatalf("SMTP body contains an unexpected recipient header: %q", body)
	}
	for _, command := range commands {
		if strings.HasPrefix(strings.ToUpper(command), "BCC:") || strings.HasPrefix(strings.ToUpper(command), "CC:") {
			t.Fatalf("unexpected recipient header command %q", command)
		}
	}
}

func TestSMTPMailerUsesMandatorySTARTTLSBeforeAuthentication(t *testing.T) {
	server := newSyntheticSMTPServer(t, syntheticSMTPOptions{
		advertiseStartTLS: true,
		authUser:          "smtp-user",
		authPassword:      "smtp-password",
	})
	config := syntheticMailConfig(server, "starttls")
	config.Username = "smtp-user"
	config.Password = "smtp-password"

	err := NewSMTPMailer(SMTPMailerOptions{Timeout: time.Second, tlsConfig: &tls.Config{RootCAs: server.rootCAs}}).Send(
		context.Background(), config, Message{Subject: "subject", Text: "body", HTML: "<p>body</p>"}, "recipient@example.test",
	)
	if err != nil {
		t.Fatalf("Send() error = %v", err)
	}
	_, _, tlsSeen, authSeen, authBeforeTLS := server.snapshot()
	if !tlsSeen || !authSeen || authBeforeTLS {
		t.Fatalf("TLS/authentication order: tls=%v auth=%v authBeforeTLS=%v", tlsSeen, authSeen, authBeforeTLS)
	}
}

func TestSMTPMailerRejectsMissingSTARTTLS(t *testing.T) {
	server := newSyntheticSMTPServer(t, syntheticSMTPOptions{authUser: "smtp-user", authPassword: "smtp-password"})
	config := syntheticMailConfig(server, "starttls")
	config.Username = "smtp-user"
	config.Password = "smtp-password"

	err := NewSMTPMailer(SMTPMailerOptions{Timeout: time.Second, tlsConfig: &tls.Config{RootCAs: server.rootCAs}}).Send(
		context.Background(), config, Message{Subject: "subject", Text: "body", HTML: "<p>body</p>"}, "recipient@example.test",
	)
	if !hasProviderCode(err, CodeSMTPFailed) {
		t.Fatalf("error=%v, want %s", err, CodeSMTPFailed)
	}
	_, _, tlsSeen, authSeen, authBeforeTLS := server.snapshot()
	if tlsSeen || authSeen || authBeforeTLS {
		t.Fatalf("unexpected insecure negotiation: tls=%v auth=%v authBeforeTLS=%v", tlsSeen, authSeen, authBeforeTLS)
	}
}

func TestSMTPMailerRejectsSTARTTLSFailure(t *testing.T) {
	server := newSyntheticSMTPServer(t, syntheticSMTPOptions{advertiseStartTLS: true, failStartTLS: true})
	config := syntheticMailConfig(server, "starttls")

	err := NewSMTPMailer(SMTPMailerOptions{Timeout: time.Second, tlsConfig: &tls.Config{RootCAs: server.rootCAs}}).Send(
		context.Background(), config, Message{Subject: "subject", Text: "body", HTML: "<p>body</p>"}, "recipient@example.test",
	)
	if !hasProviderCode(err, CodeSMTPFailed) {
		t.Fatalf("error=%v, want %s", err, CodeSMTPFailed)
	}
	_, _, tlsSeen, authSeen, authBeforeTLS := server.snapshot()
	if tlsSeen || authSeen || authBeforeTLS {
		t.Fatalf("unexpected negotiation after STARTTLS failure: tls=%v auth=%v authBeforeTLS=%v", tlsSeen, authSeen, authBeforeTLS)
	}
}

func TestSMTPMailerRejectsUntrustedImplicitTLS(t *testing.T) {
	server := newSyntheticSMTPServer(t, syntheticSMTPOptions{implicitTLS: true})
	config := syntheticMailConfig(server, "tls")

	err := NewSMTPMailer(SMTPMailerOptions{Timeout: time.Second}).Send(
		context.Background(), config, Message{Subject: "subject", Text: "body", HTML: "<p>body</p>"}, "recipient@example.test",
	)
	if !hasProviderCode(err, CodeSMTPFailed) {
		t.Fatalf("error=%v, want %s", err, CodeSMTPFailed)
	}
	_, _, _, authSeen, authBeforeTLS := server.snapshot()
	if authSeen || authBeforeTLS {
		t.Fatalf("credentials were attempted after certificate rejection: auth=%v authBeforeTLS=%v", authSeen, authBeforeTLS)
	}
}

func TestSMTPMailerForcesInjectedTLSConfigToVerifyCertificates(t *testing.T) {
	server := newSyntheticSMTPServer(t, syntheticSMTPOptions{implicitTLS: true})
	config := syntheticMailConfig(server, "tls")

	err := NewSMTPMailer(SMTPMailerOptions{
		Timeout:   time.Second,
		tlsConfig: &tls.Config{InsecureSkipVerify: true},
	}).Send(context.Background(), config, Message{Subject: "subject", Text: "body", HTML: "<p>body</p>"}, "recipient@example.test")
	if !hasProviderCode(err, CodeSMTPFailed) {
		t.Fatalf("error=%v, want %s", err, CodeSMTPFailed)
	}
	_, _, _, authSeen, authBeforeTLS := server.snapshot()
	if authSeen || authBeforeTLS {
		t.Fatalf("credentials were attempted after insecure TLS config was rejected: auth=%v authBeforeTLS=%v", authSeen, authBeforeTLS)
	}
}

func TestSMTPMailerUsesImplicitTLSBeforeAuthentication(t *testing.T) {
	server := newSyntheticSMTPServer(t, syntheticSMTPOptions{
		implicitTLS:  true,
		authUser:     "smtp-user",
		authPassword: "smtp-password",
	})
	config := syntheticMailConfig(server, "tls")
	config.Username = "smtp-user"
	config.Password = "smtp-password"

	err := NewSMTPMailer(SMTPMailerOptions{Timeout: time.Second, tlsConfig: &tls.Config{RootCAs: server.rootCAs}}).Send(
		context.Background(), config, Message{Subject: "subject", Text: "body", HTML: "<p>body</p>"}, "recipient@example.test",
	)
	if err != nil {
		t.Fatalf("Send() error = %v", err)
	}
	_, _, tlsSeen, authSeen, authBeforeTLS := server.snapshot()
	if !tlsSeen || !authSeen || authBeforeTLS {
		t.Fatalf("TLS/authentication order: tls=%v auth=%v authBeforeTLS=%v", tlsSeen, authSeen, authBeforeTLS)
	}
}

func TestSMTPMailerHonorsContextCancellationDuringSlowResponse(t *testing.T) {
	server := newSyntheticSMTPServer(t, syntheticSMTPOptions{delayDataResponse: 500 * time.Millisecond})
	config := syntheticMailConfig(server, "none")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan error, 1)
	go func() {
		result <- NewSMTPMailer(SMTPMailerOptions{Timeout: 2 * time.Second}).Send(
			ctx, config, Message{Subject: "subject", Text: "body", HTML: "<p>body</p>"}, "recipient@example.test",
		)
	}()
	server.waitForData(t, time.Second)
	cancel()
	select {
	case err := <-result:
		if !hasProviderCode(err, CodeSMTPTimeout) {
			t.Fatalf("error=%v, want %s", err, CodeSMTPTimeout)
		}
	case <-time.After(time.Second):
		t.Fatal("Send did not stop after context cancellation")
	}
}

func TestSMTPMailerHonorsContextDeadlineDuringSlowResponse(t *testing.T) {
	server := newSyntheticSMTPServer(t, syntheticSMTPOptions{delayDataResponse: 500 * time.Millisecond})
	config := syntheticMailConfig(server, "none")
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	result := make(chan error, 1)
	go func() {
		result <- NewSMTPMailer(SMTPMailerOptions{Timeout: 2 * time.Second}).Send(
			ctx, config, Message{Subject: "subject", Text: "body", HTML: "<p>body</p>"}, "recipient@example.test",
		)
	}()
	server.waitForData(t, time.Second)
	select {
	case err := <-result:
		if !hasProviderCode(err, CodeSMTPTimeout) {
			t.Fatalf("error=%v, want %s", err, CodeSMTPTimeout)
		}
	case <-time.After(time.Second):
		t.Fatal("Send did not stop after context deadline")
	}
}

func TestSMTPMailerTimesOutSlowGreeting(t *testing.T) {
	server := newSyntheticSMTPServer(t, syntheticSMTPOptions{delayGreeting: 250 * time.Millisecond})
	config := syntheticMailConfig(server, "none")
	err := NewSMTPMailer(SMTPMailerOptions{Timeout: 30 * time.Millisecond}).Send(
		context.Background(), config, Message{Subject: "subject", Text: "body", HTML: "<p>body</p>"}, "recipient@example.test",
	)
	if !hasProviderCode(err, CodeSMTPTimeout) {
		t.Fatalf("error=%v, want %s", err, CodeSMTPTimeout)
	}
}

func TestSMTPMailerClosesConnectionsAfterDialFailureAndSuccess(t *testing.T) {
	t.Run("greeting failure", func(t *testing.T) {
		server := newSyntheticSMTPServer(t, syntheticSMTPOptions{rejectGreeting: true})
		config := syntheticMailConfig(server, "none")
		result := make(chan error, 1)
		go func() {
			result <- NewSMTPMailer(SMTPMailerOptions{Timeout: time.Second}).Send(
				context.Background(), config, Message{Subject: "subject", Text: "body", HTML: "<p>body</p>"}, "recipient@example.test",
			)
		}()
		server.waitForConnection(t, time.Second)
		if err := <-result; !hasProviderCode(err, CodeSMTPFailed) {
			t.Fatalf("error=%v, want %s", err, CodeSMTPFailed)
		}
		server.waitForNoConnections(t, time.Second)
	})

	t.Run("successful send", func(t *testing.T) {
		server := newSyntheticSMTPServer(t, syntheticSMTPOptions{})
		config := syntheticMailConfig(server, "none")
		result := make(chan error, 1)
		go func() {
			result <- NewSMTPMailer(SMTPMailerOptions{Timeout: time.Second}).Send(
				context.Background(), config, Message{Subject: "subject", Text: "body", HTML: "<p>body</p>"}, "recipient@example.test",
			)
		}()
		server.waitForConnection(t, time.Second)
		if err := <-result; err != nil {
			t.Fatalf("Send() error = %v", err)
		}
		server.waitForNoConnections(t, time.Second)
	})
}

func TestSMTPMailerCancellationDuringGreetingClosesConnection(t *testing.T) {
	server := newSyntheticSMTPServer(t, syntheticSMTPOptions{stallGreeting: true})
	config := syntheticMailConfig(server, "none")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan error, 1)
	go func() {
		result <- NewSMTPMailer(SMTPMailerOptions{Timeout: 5 * time.Second}).Send(
			ctx, config, Message{Subject: "subject", Text: "body", HTML: "<p>body</p>"}, "recipient@example.test",
		)
	}()
	server.waitForConnection(t, time.Second)
	cancel()
	assertSMTPTimeoutQuickly(t, result)
	assertNoSMTPQuit(t, server)
}

func TestSMTPMailerCancellationDuringSTARTTLSClosesConnection(t *testing.T) {
	server := newSyntheticSMTPServer(t, syntheticSMTPOptions{advertiseStartTLS: true, stallStartTLS: true})
	config := syntheticMailConfig(server, "starttls")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan error, 1)
	go func() {
		result <- NewSMTPMailer(SMTPMailerOptions{Timeout: 5 * time.Second}).Send(
			ctx, config, Message{Subject: "subject", Text: "body", HTML: "<p>body</p>"}, "recipient@example.test",
		)
	}()
	server.waitForStartTLS(t, time.Second)
	cancel()
	assertSMTPTimeoutQuickly(t, result)
	assertNoSMTPQuit(t, server)
}

func TestSMTPMailerCancellationDuringImplicitTLSHandshakeClosesConnection(t *testing.T) {
	server := newSyntheticSMTPServer(t, syntheticSMTPOptions{implicitTLS: true, stallTLSHandshake: true})
	config := syntheticMailConfig(server, "tls")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan error, 1)
	go func() {
		result <- NewSMTPMailer(SMTPMailerOptions{
			Timeout: time.Second, tlsConfig: &tls.Config{RootCAs: server.rootCAs},
		}).Send(ctx, config, Message{Subject: "subject", Text: "body", HTML: "<p>body</p>"}, "recipient@example.test")
	}()
	server.waitForTLSHandshake(t, time.Second)
	cancel()
	assertSMTPTimeoutQuickly(t, result)
	assertNoSMTPQuit(t, server)
}

func TestSMTPMailerCancellationDuringAuthenticationClosesConnection(t *testing.T) {
	server := newSyntheticSMTPServer(t, syntheticSMTPOptions{
		implicitTLS: true, stallAuth: true, authUser: "smtp-user", authPassword: "smtp-password",
	})
	config := syntheticMailConfig(server, "tls")
	config.Username = "smtp-user"
	config.Password = "smtp-password"
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan error, 1)
	go func() {
		result <- NewSMTPMailer(SMTPMailerOptions{
			Timeout: time.Second, tlsConfig: &tls.Config{RootCAs: server.rootCAs},
		}).Send(ctx, config, Message{Subject: "subject", Text: "body", HTML: "<p>body</p>"}, "recipient@example.test")
	}()
	server.waitForAuth(t, time.Second)
	cancel()
	assertSMTPTimeoutQuickly(t, result)
	assertNoSMTPQuit(t, server)
}

func TestSMTPMailerCancellationDuringDataResponseClosesConnection(t *testing.T) {
	server := newSyntheticSMTPServer(t, syntheticSMTPOptions{stallDataResponse: true})
	config := syntheticMailConfig(server, "none")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan error, 1)
	go func() {
		result <- NewSMTPMailer(SMTPMailerOptions{Timeout: 5 * time.Second}).Send(
			ctx, config, Message{Subject: "subject", Text: "body", HTML: "<p>body</p>"}, "recipient@example.test",
		)
	}()
	server.waitForData(t, time.Second)
	cancel()
	assertSMTPTimeoutQuickly(t, result)
	assertNoSMTPQuit(t, server)
}

func TestSMTPMailerDeadlineDuringQuitClosesConnectionWithinOperationBudget(t *testing.T) {
	server := newSyntheticSMTPServer(t, syntheticSMTPOptions{stallQuit: true})
	config := syntheticMailConfig(server, "none")
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	result := make(chan error, 1)
	started := time.Now()
	go func() {
		result <- NewSMTPMailer(SMTPMailerOptions{Timeout: 5 * time.Second}).Send(
			ctx, config, Message{Subject: "subject", Text: "body", HTML: "<p>body</p>"}, "recipient@example.test",
		)
	}()
	server.waitForQuit(t, time.Second)
	assertSMTPTimeoutQuickly(t, result)
	if elapsed := time.Since(started); elapsed > 500*time.Millisecond {
		t.Fatalf("operation exceeded absolute budget: elapsed=%s", elapsed)
	}
}

func TestSMTPMailerRedactsProviderAuthenticationErrors(t *testing.T) {
	const providerSecret = "provider-secret-should-not-escape"
	server := newSyntheticSMTPServer(t, syntheticSMTPOptions{
		implicitTLS:      true,
		authUser:         "smtp-user",
		authPassword:     "smtp-password",
		rejectAuth:       true,
		authErrorMessage: "535 5.7.8 provider-secret=" + providerSecret,
	})
	config := syntheticMailConfig(server, "tls")
	config.Username = "smtp-user"
	config.Password = "smtp-password"
	err := NewSMTPMailer(SMTPMailerOptions{Timeout: time.Second, tlsConfig: &tls.Config{RootCAs: server.rootCAs}}).Send(
		context.Background(), config, Message{Subject: "subject", Text: "body", HTML: "<p>body</p>"}, "recipient@example.test",
	)
	if !hasProviderCode(err, CodeSMTPAuthFailed) {
		t.Fatalf("error=%v, want %s", err, CodeSMTPAuthFailed)
	}
	if strings.Contains(err.Error(), providerSecret) || strings.Contains(err.Error(), "535") {
		t.Fatalf("provider error leaked: %v", err)
	}
}

func syntheticMailConfig(server *syntheticSMTPServer, encryption string) MailConfig {
	return MailConfig{
		SMTPHost:    "127.0.0.1",
		SMTPPort:    server.port(),
		Encryption:  encryption,
		FromAddress: "sender@example.test",
		FromName:    "DualLane",
	}
}

func hasProviderCode(err error, code string) bool {
	provider, ok := err.(*ProviderError)
	return ok && provider.Code == code
}

func assertSMTPTimeoutQuickly(t *testing.T, result <-chan error) {
	t.Helper()
	select {
	case err := <-result:
		if !hasProviderCode(err, CodeSMTPTimeout) {
			t.Fatalf("error=%v, want %s", err, CodeSMTPTimeout)
		}
	case <-time.After(250 * time.Millisecond):
		t.Fatal("SMTP operation did not stop within cancellation window")
	}
}

func assertNoSMTPQuit(t *testing.T, server *syntheticSMTPServer) {
	t.Helper()
	_, commands, _, _, _ := server.snapshot()
	for _, command := range commands {
		if strings.EqualFold(strings.TrimSpace(command), "QUIT") {
			t.Fatalf("cancellation sent QUIT: commands=%v", commands)
		}
	}
}
