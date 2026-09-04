package email

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"mime"
	"net"
	"net/mail"
	netsmtp "net/smtp"
	"strings"
	"time"
)

// SMTPMailer is the production-safe adapter used by the worker and by the
// owner SMTP proof flow. It never returns an SMTP response body or credentials
// to the service; callers receive only stable provider classifications.
type SMTPMailerOptions struct {
	Timeout time.Duration
}

type SMTPMailer struct {
	timeout   time.Duration
	configErr error
}

func NewSMTPMailer(options SMTPMailerOptions) *SMTPMailer {
	timeout := options.Timeout
	if timeout <= 0 {
		timeout = DefaultPublishTimeout
	}
	return &SMTPMailer{timeout: timeout}
}

func (m *SMTPMailer) Send(ctx context.Context, config MailConfig, message Message, recipient string) error {
	if m == nil || m.configErr != nil {
		return &ProviderError{Code: CodeSMTPFailed}
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if !validSMTPConfig(config) || !safeRecipient(recipient) || strings.ContainsAny(message.Subject+message.Text+message.HTML, "\x00") {
		return &ProviderError{Code: CodeSMTPFailed}
	}
	if config.Encryption == "none" && config.Username != "" {
		// Plain SMTP authentication would disclose the credential on the wire.
		return &ProviderError{Code: CodeSMTPAuthFailed}
	}
	timeout := m.timeout
	if deadline, ok := ctx.Deadline(); ok {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return &ProviderError{Code: CodeSMTPTimeout, Timeout: true}
		}
		if remaining < timeout {
			timeout = remaining
		}
	}
	dialCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	dialer := net.Dialer{Timeout: timeout}
	address := net.JoinHostPort(config.SMTPHost, fmt.Sprintf("%d", config.SMTPPort))
	var conn net.Conn
	var err error
	if config.Encryption == "tls" {
		conn, err = tls.DialWithDialer(&dialer, "tcp", address, &tls.Config{ServerName: config.SMTPHost, MinVersion: tls.VersionTLS12})
	} else {
		conn, err = dialer.DialContext(dialCtx, "tcp", address)
	}
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) || isTimeoutError(err) {
			return &ProviderError{Code: CodeSMTPTimeout, Timeout: true}
		}
		return &ProviderError{Code: CodeSMTPUnreachable}
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(timeout))
	client, err := netsmtp.NewClient(conn, config.SMTPHost)
	if err != nil {
		return classifySMTPError(err)
	}
	defer client.Close()
	secure := config.Encryption == "tls"
	if config.Encryption == "starttls" {
		if ok, _ := client.Extension("STARTTLS"); !ok {
			return &ProviderError{Code: CodeSMTPFailed}
		}
		if err := client.StartTLS(&tls.Config{ServerName: config.SMTPHost, MinVersion: tls.VersionTLS12}); err != nil {
			return classifySMTPError(err)
		}
		secure = true
	}
	if config.Username != "" {
		if !secure {
			return &ProviderError{Code: CodeSMTPAuthFailed}
		}
		if err := client.Auth(netsmtp.PlainAuth("", config.Username, config.Password, config.SMTPHost)); err != nil {
			return &ProviderError{Code: CodeSMTPAuthFailed}
		}
	}
	fromAddress := mail.Address{Name: config.FromName, Address: config.FromAddress}
	from := fromAddress.String()
	if err := client.Mail(config.FromAddress); err != nil {
		return classifySMTPError(err)
	}
	if err := client.Rcpt(strings.TrimSpace(recipient)); err != nil {
		return classifySMTPError(err)
	}
	writer, err := client.Data()
	if err != nil {
		return classifySMTPError(err)
	}
	body := buildRFCMessage(from, recipient, message)
	if _, err := writer.Write([]byte(body)); err != nil {
		_ = writer.Close()
		return classifySMTPError(err)
	}
	if err := writer.Close(); err != nil {
		return classifySMTPError(err)
	}
	if err := client.Quit(); err != nil {
		return classifySMTPError(err)
	}
	return nil
}

func validSMTPConfig(config MailConfig) bool {
	return safeMailConfig(config) && !strings.ContainsAny(config.SMTPHost, "\r\n \t") &&
		!strings.ContainsAny(config.Username+config.Password+config.FromName+config.FromAddress, "\r\n")
}

func classifySMTPError(err error) error {
	if err == nil {
		return &ProviderError{Code: CodeSMTPFailed}
	}
	if isTimeoutError(err) {
		return &ProviderError{Code: CodeSMTPTimeout, Timeout: true}
	}
	message := strings.ToLower(err.Error())
	if strings.Contains(message, "535") || strings.Contains(message, "authentication") || strings.Contains(message, "auth") {
		return &ProviderError{Code: CodeSMTPAuthFailed}
	}
	return &ProviderError{Code: CodeSMTPFailed}
}

func isTimeoutError(err error) bool {
	var timeout interface{ Timeout() bool }
	return errors.As(err, &timeout) && timeout.Timeout()
}

func buildRFCMessage(from, recipient string, message Message) string {
	encodedSubject := mime.QEncoding.Encode("UTF-8", message.Subject)
	contentType := "multipart/alternative; boundary=\"duallane-email\""
	var builder strings.Builder
	builder.WriteString("From: ")
	builder.WriteString(from)
	builder.WriteString("\r\nTo: ")
	builder.WriteString(recipient)
	builder.WriteString("\r\nSubject: ")
	builder.WriteString(encodedSubject)
	builder.WriteString("\r\nMIME-Version: 1.0\r\nContent-Type: ")
	builder.WriteString(contentType)
	builder.WriteString("\r\n\r\n--duallane-email\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n")
	builder.WriteString(strings.ReplaceAll(message.Text, "\n", "\r\n"))
	builder.WriteString("\r\n--duallane-email\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n")
	builder.WriteString(strings.ReplaceAll(message.HTML, "\n", "\r\n"))
	builder.WriteString("\r\n--duallane-email--\r\n")
	return builder.String()
}
