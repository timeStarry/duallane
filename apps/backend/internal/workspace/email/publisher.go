package email

import (
	"context"
	"crypto/tls"
	"errors"
	"net"
	"strings"
	"sync"
	"time"

	mail "github.com/wneessen/go-mail"
)

// SMTPMailer is the production-safe adapter used by the worker and by the
// owner SMTP proof flow. It never returns an SMTP response body or credentials
// to the service; callers receive only stable provider classifications.
type SMTPMailerOptions struct {
	Timeout time.Duration

	// tlsConfig is an internal test seam. Production callers leave it nil so
	// the adapter uses the host's system trust store. It is never allowed to
	// enable InsecureSkipVerify.
	tlsConfig *tls.Config
}

type SMTPMailer struct {
	timeout   time.Duration
	tlsConfig *tls.Config
}

func NewSMTPMailer(options SMTPMailerOptions) *SMTPMailer {
	timeout := options.Timeout
	if timeout <= 0 {
		timeout = DefaultPublishTimeout
	}
	var tlsConfig *tls.Config
	if options.tlsConfig != nil {
		tlsConfig = options.tlsConfig.Clone()
	}
	return &SMTPMailer{timeout: timeout, tlsConfig: tlsConfig}
}

func (m *SMTPMailer) Send(ctx context.Context, config MailConfig, message Message, recipient string) error {
	if m == nil {
		return &ProviderError{Code: CodeSMTPFailed}
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if !validSMTPConfig(config) || !safeRecipient(recipient) ||
		strings.ContainsAny(message.Subject, "\r\n") ||
		strings.ContainsAny(message.Subject+message.Text+message.HTML, "\x00") {
		return &ProviderError{Code: CodeSMTPFailed}
	}
	if config.Encryption == "none" && config.Username != "" {
		// Plain SMTP authentication would disclose the credential on the wire.
		return &ProviderError{Code: CodeSMTPAuthFailed}
	}
	timeout := m.timeout
	if timeout <= 0 {
		timeout = DefaultPublishTimeout
	}
	if deadline, ok := ctx.Deadline(); ok {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return &ProviderError{Code: CodeSMTPTimeout, Timeout: true}
		}
		if remaining < timeout {
			timeout = remaining
		}
	}
	operationCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	operationDeadline, ok := operationCtx.Deadline()
	if !ok || operationExpired(operationCtx, operationDeadline) {
		return &ProviderError{Code: CodeSMTPTimeout, Timeout: true}
	}
	msg, err := buildMailMessage(config, message, recipient)
	if err != nil {
		return &ProviderError{Code: CodeSMTPFailed}
	}
	tlsConfig := m.tlsConfigFor(config.SMTPHost)
	connectionTracker := newSMTPConnectionTracker(operationDeadline)
	options := []mail.Option{
		mail.WithPort(config.SMTPPort),
		mail.WithTimeout(time.Until(operationDeadline)),
		mail.WithTLSConfig(tlsConfig),
		mail.WithDialContextFunc(m.dialContext(config, tlsConfig, connectionTracker)),
	}
	switch config.Encryption {
	case "tls":
		options = append(options, mail.WithSSL())
	case "starttls":
		options = append(options, mail.WithTLSPortPolicy(mail.TLSMandatory))
	case "none":
		options = append(options, mail.WithTLSPolicy(mail.NoTLS))
	}
	if config.Username != "" {
		options = append(options,
			mail.WithUsername(config.Username),
			mail.WithPassword(config.Password),
			mail.WithSMTPAuth(mail.SMTPAuthPlain),
		)
	}
	watchStop := make(chan struct{})
	watchDone := make(chan struct{})
	go func() {
		defer close(watchDone)
		select {
		case <-operationCtx.Done():
			// Cancellation must interrupt the active I/O directly. Calling
			// client.Close here would send QUIT concurrently with Send and can
			// wait for a server response after DATA has stalled.
			connectionTracker.close()
		case <-watchStop:
		}
	}()
	defer func() {
		close(watchStop)
		<-watchDone
		connectionTracker.close()
	}()
	client, err := mail.NewClient(config.SMTPHost, options...)
	if err != nil {
		if operationExpired(operationCtx, operationDeadline) {
			return &ProviderError{Code: CodeSMTPTimeout, Timeout: true}
		}
		return classifySMTPError(err)
	}
	if err := client.DialWithContext(operationCtx); err != nil {
		if operationExpired(operationCtx, operationDeadline) {
			return &ProviderError{Code: CodeSMTPTimeout, Timeout: true}
		}
		return classifySMTPError(err)
	}

	sendErr := client.Send(msg)
	if operationExpired(operationCtx, operationDeadline) {
		return &ProviderError{Code: CodeSMTPTimeout, Timeout: true}
	}
	if sendErr != nil {
		return classifySMTPError(sendErr)
	}
	closeErr := client.Close()
	if operationExpired(operationCtx, operationDeadline) {
		return &ProviderError{Code: CodeSMTPTimeout, Timeout: true}
	}
	if closeErr != nil {
		return classifySMTPError(closeErr)
	}
	return nil
}

func operationExpired(ctx context.Context, deadline time.Time) bool {
	return (ctx != nil && ctx.Err() != nil) || (!deadline.IsZero() && !time.Now().Before(deadline))
}

type smtpConnectionTracker struct {
	mu       sync.Mutex
	conn     net.Conn
	deadline time.Time
	closed   bool
}

func newSMTPConnectionTracker(deadline time.Time) *smtpConnectionTracker {
	return &smtpConnectionTracker{deadline: deadline}
}

func (t *smtpConnectionTracker) set(conn net.Conn) {
	if t == nil || conn == nil {
		return
	}
	t.mu.Lock()
	if t.closed {
		t.mu.Unlock()
		_ = conn.Close()
		return
	}
	t.conn = conn
	t.mu.Unlock()
}

func (t *smtpConnectionTracker) close() {
	if t == nil {
		return
	}
	t.mu.Lock()
	if t.closed {
		t.mu.Unlock()
		return
	}
	t.closed = true
	conn := t.conn
	t.mu.Unlock()
	if conn != nil {
		_ = conn.Close()
	}
}

func (m *SMTPMailer) dialContext(config MailConfig, tlsConfig *tls.Config, tracker *smtpConnectionTracker) mail.DialContextFunc {
	return func(ctx context.Context, network, address string) (net.Conn, error) {
		dialer := net.Dialer{}
		conn, err := dialer.DialContext(ctx, network, address)
		if err != nil {
			return nil, err
		}
		tracked := &deadlineConn{Conn: conn, deadline: tracker.deadline}
		tracker.set(tracked)
		if config.Encryption != "tls" {
			return tracked, nil
		}
		secure := tls.Client(tracked, tlsConfig)
		if err := secure.HandshakeContext(ctx); err != nil {
			_ = secure.Close()
			return nil, err
		}
		return secure, nil
	}
}

type deadlineConn struct {
	net.Conn
	deadline time.Time
	mu       sync.Mutex
	closed   bool
}

func (c *deadlineConn) Close() error {
	if c == nil || c.Conn == nil {
		return nil
	}
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil
	}
	c.closed = true
	c.mu.Unlock()
	return c.Conn.Close()
}

func (c *deadlineConn) SetDeadline(deadline time.Time) error {
	return c.Conn.SetDeadline(c.clamp(deadline))
}

func (c *deadlineConn) SetReadDeadline(deadline time.Time) error {
	return c.Conn.SetReadDeadline(c.clamp(deadline))
}

func (c *deadlineConn) SetWriteDeadline(deadline time.Time) error {
	return c.Conn.SetWriteDeadline(c.clamp(deadline))
}

func (c *deadlineConn) clamp(deadline time.Time) time.Time {
	if c == nil || c.deadline.IsZero() {
		return deadline
	}
	if deadline.IsZero() || c.deadline.Before(deadline) {
		return c.deadline
	}
	return deadline
}

func validSMTPConfig(config MailConfig) bool {
	return safeMailConfig(config) && !strings.ContainsAny(config.SMTPHost, "\r\n \t") &&
		!strings.ContainsAny(config.Username+config.Password+config.FromName+config.FromAddress, "\r\n")
}

func classifySMTPError(err error) error {
	if err == nil {
		return &ProviderError{Code: CodeSMTPFailed}
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return &ProviderError{Code: CodeSMTPTimeout, Timeout: true}
	}
	if isTimeoutError(err) {
		return &ProviderError{Code: CodeSMTPTimeout, Timeout: true}
	}
	message := strings.ToLower(err.Error())
	if strings.Contains(message, "certificate") || strings.Contains(message, "unknown authority") || strings.Contains(message, "x509:") {
		return &ProviderError{Code: CodeSMTPFailed}
	}
	var netErr *net.OpError
	if errors.As(err, &netErr) {
		return &ProviderError{Code: CodeSMTPUnreachable}
	}
	if strings.Contains(message, "535") || strings.Contains(message, "authentication") || strings.Contains(message, "auth") {
		return &ProviderError{Code: CodeSMTPAuthFailed}
	}
	if strings.Contains(message, "connection refused") || strings.Contains(message, "no such host") || strings.Contains(message, "temporary failure in name resolution") {
		return &ProviderError{Code: CodeSMTPUnreachable}
	}
	return &ProviderError{Code: CodeSMTPFailed}
}

func isTimeoutError(err error) bool {
	var timeout interface{ Timeout() bool }
	return errors.As(err, &timeout) && timeout.Timeout()
}

func (m *SMTPMailer) tlsConfigFor(host string) *tls.Config {
	config := &tls.Config{}
	if m != nil && m.tlsConfig != nil {
		config = m.tlsConfig.Clone()
	}
	config.ServerName = host
	config.MinVersion = tls.VersionTLS12
	config.InsecureSkipVerify = false
	return config
}

func buildMailMessage(config MailConfig, message Message, recipient string) (*mail.Msg, error) {
	msg := mail.NewMsg(mail.WithNoDefaultUserAgent())
	var err error
	if config.FromName == "" {
		err = msg.From(config.FromAddress)
	} else {
		err = msg.FromFormat(config.FromName, config.FromAddress)
	}
	if err != nil {
		return nil, err
	}
	if err := msg.To(strings.TrimSpace(recipient)); err != nil {
		return nil, err
	}
	msg.Subject(message.Subject)
	msg.SetBodyString(mail.ContentType("text/plain"), message.Text)
	msg.AddAlternativeString(mail.ContentType("text/html"), message.HTML)
	return msg, nil
}
