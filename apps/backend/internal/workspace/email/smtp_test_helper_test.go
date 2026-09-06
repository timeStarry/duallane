package email

import (
	"bufio"
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"strings"
	"sync"
	"testing"
	"time"
)

type syntheticSMTPOptions struct {
	implicitTLS       bool
	advertiseStartTLS bool
	failStartTLS      bool
	delayGreeting     time.Duration
	delayDataResponse time.Duration
	rejectGreeting    bool
	stallGreeting     bool
	stallStartTLS     bool
	stallTLSHandshake bool
	stallAuth         bool
	stallDataResponse bool
	stallQuit         bool
	authUser          string
	authPassword      string
	rejectAuth        bool
	authErrorMessage  string
}

type syntheticSMTPServer struct {
	listener net.Listener
	tls      *tls.Config
	rootCAs  *x509.CertPool
	options  syntheticSMTPOptions
	barrier  chan struct{}

	mu               sync.Mutex
	connections      map[net.Conn]struct{}
	commands         []string
	body             string
	tlsSeen          bool
	authSeen         bool
	authBeforeTLS    bool
	connectionStart  chan struct{}
	connectionOnce   sync.Once
	startTLS         chan struct{}
	startTLSOnce     sync.Once
	tlsHandshake     chan struct{}
	tlsHandshakeOnce sync.Once
	authStart        chan struct{}
	authStartOnce    sync.Once
	dataStarted      chan struct{}
	dataStartedOnce  sync.Once
	quitStart        chan struct{}
	quitStartOnce    sync.Once
	barrierOnce      sync.Once
	closeOnce        sync.Once
}

func newSyntheticSMTPServer(t *testing.T, options syntheticSMTPOptions) *syntheticSMTPServer {
	t.Helper()
	certificate, rootCAs := newSyntheticTLSCertificate(t)
	config := &tls.Config{Certificates: []tls.Certificate{certificate}, MinVersion: tls.VersionTLS12}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	if options.implicitTLS {
		listener = tls.NewListener(listener, config)
	}
	server := &syntheticSMTPServer{
		listener:        listener,
		tls:             config,
		rootCAs:         rootCAs,
		options:         options,
		barrier:         make(chan struct{}),
		connections:     make(map[net.Conn]struct{}),
		connectionStart: make(chan struct{}),
		startTLS:        make(chan struct{}),
		tlsHandshake:    make(chan struct{}),
		authStart:       make(chan struct{}),
		dataStarted:     make(chan struct{}),
		quitStart:       make(chan struct{}),
	}
	t.Cleanup(server.Close)
	go server.serve()
	return server
}

func (s *syntheticSMTPServer) address() string {
	return s.listener.Addr().String()
}

func (s *syntheticSMTPServer) port() int {
	_, port, err := net.SplitHostPort(s.address())
	if err != nil {
		return 0
	}
	var value int
	_, _ = fmt.Sscanf(port, "%d", &value)
	return value
}

func (s *syntheticSMTPServer) Close() {
	s.barrierOnce.Do(func() { close(s.barrier) })
	s.closeOnce.Do(func() {
		_ = s.listener.Close()
		s.mu.Lock()
		for connection := range s.connections {
			_ = connection.Close()
		}
		s.mu.Unlock()
	})
}

func (s *syntheticSMTPServer) waitForConnection(t *testing.T, timeout time.Duration) {
	t.Helper()
	s.waitForSignal(t, s.connectionStart, timeout, "synthetic SMTP server did not accept a connection")
}

func (s *syntheticSMTPServer) waitForStartTLS(t *testing.T, timeout time.Duration) {
	t.Helper()
	s.waitForSignal(t, s.startTLS, timeout, "synthetic SMTP server did not receive STARTTLS")
}

func (s *syntheticSMTPServer) waitForTLSHandshake(t *testing.T, timeout time.Duration) {
	t.Helper()
	s.waitForSignal(t, s.tlsHandshake, timeout, "synthetic SMTP server did not begin TLS handshake")
}

func (s *syntheticSMTPServer) waitForAuth(t *testing.T, timeout time.Duration) {
	t.Helper()
	s.waitForSignal(t, s.authStart, timeout, "synthetic SMTP server did not receive AUTH")
}

func (s *syntheticSMTPServer) waitForQuit(t *testing.T, timeout time.Duration) {
	t.Helper()
	s.waitForSignal(t, s.quitStart, timeout, "synthetic SMTP server did not receive QUIT")
}

func (s *syntheticSMTPServer) waitForSignal(t *testing.T, signal <-chan struct{}, timeout time.Duration, message string) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(timeout):
		t.Fatal(message)
	}
}

func (s *syntheticSMTPServer) awaitBarrier() {
	<-s.barrier
}

func (s *syntheticSMTPServer) waitForNoConnections(t *testing.T, timeout time.Duration) {
	t.Helper()
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		s.mu.Lock()
		count := len(s.connections)
		s.mu.Unlock()
		if count == 0 {
			return
		}
		select {
		case <-ticker.C:
		case <-deadline.C:
			t.Fatal("synthetic SMTP connection was not closed")
		}
	}
}

func (s *syntheticSMTPServer) waitForData(t *testing.T, timeout time.Duration) {
	t.Helper()
	select {
	case <-s.dataStarted:
	case <-time.After(timeout):
		t.Fatal("synthetic SMTP server did not receive DATA")
	}
}

func (s *syntheticSMTPServer) snapshot() (body string, commands []string, tlsSeen, authSeen, authBeforeTLS bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.body, append([]string(nil), s.commands...), s.tlsSeen, s.authSeen, s.authBeforeTLS
}

func (s *syntheticSMTPServer) serve() {
	for {
		connection, err := s.listener.Accept()
		if err != nil {
			return
		}
		s.connectionOnce.Do(func() { close(s.connectionStart) })
		s.mu.Lock()
		s.connections[connection] = struct{}{}
		if s.options.implicitTLS {
			s.tlsSeen = true
		}
		s.mu.Unlock()
		go s.handle(connection, s.options.implicitTLS)
	}
}

func (s *syntheticSMTPServer) handle(connection net.Conn, tlsSeen bool) {
	trackedConnection := connection
	defer func() {
		s.mu.Lock()
		delete(s.connections, trackedConnection)
		s.mu.Unlock()
		_ = connection.Close()
	}()

	reader := bufio.NewReader(connection)
	writer := bufio.NewWriter(connection)
	if s.options.stallTLSHandshake && s.options.implicitTLS {
		s.tlsHandshakeOnce.Do(func() { close(s.tlsHandshake) })
		s.awaitBarrier()
	}
	if s.options.delayGreeting > 0 {
		time.Sleep(s.options.delayGreeting)
	}
	if s.options.stallGreeting {
		s.awaitBarrier()
	}
	if s.options.rejectGreeting {
		if !writeSMTPLine(writer, "554 synthetic greeting failure") {
			return
		}
		return
	}
	if !writeSMTPLine(writer, "220 synthetic.local ESMTP ready") {
		return
	}

	awaitingAuth := false
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			return
		}
		line = strings.TrimRight(line, "\r\n")
		s.recordCommand(line, tlsSeen)
		upper := strings.ToUpper(line)

		if awaitingAuth {
			awaitingAuth = false
			if !tlsSeen {
				s.markAuthBeforeTLS()
			}
			if s.options.rejectAuth || !s.validAuth(line) {
				if !writeSMTPLine(writer, s.authFailureLine()) {
					return
				}
			} else if !writeSMTPLine(writer, "235 2.7.0 authenticated") {
				return
			}
			continue
		}

		switch {
		case strings.HasPrefix(upper, "EHLO ") || strings.HasPrefix(upper, "HELO "):
			if !s.writeGreetingExtensions(writer, tlsSeen) {
				return
			}
		case strings.HasPrefix(upper, "STARTTLS"):
			if s.options.stallStartTLS {
				s.awaitBarrier()
			}
			if !s.options.advertiseStartTLS || tlsSeen {
				if !writeSMTPLine(writer, "454 4.7.0 TLS not available") {
					return
				}
				continue
			}
			if s.options.failStartTLS {
				_ = writeSMTPLine(writer, "454 4.7.0 synthetic STARTTLS failure")
				return
			}
			if !writeSMTPLine(writer, "220 2.0.0 Ready to start TLS") {
				return
			}
			tlsConnection := tls.Server(connection, s.tls)
			if err := tlsConnection.Handshake(); err != nil {
				return
			}
			connection = tlsConnection
			reader = bufio.NewReader(connection)
			writer = bufio.NewWriter(connection)
			tlsSeen = true
			s.mu.Lock()
			s.tlsSeen = true
			s.mu.Unlock()
		case strings.HasPrefix(upper, "AUTH PLAIN"):
			if s.options.stallAuth {
				s.awaitBarrier()
			}
			s.markAuthSeen(tlsSeen)
			if !tlsSeen {
				if !writeSMTPLine(writer, "538 5.7.11 encryption required") {
					return
				}
				return
			}
			parts := strings.Fields(line)
			if len(parts) > 2 {
				if s.options.rejectAuth || !s.validAuth(parts[2]) {
					if !writeSMTPLine(writer, s.authFailureLine()) {
						return
					}
				} else if !writeSMTPLine(writer, "235 2.7.0 authenticated") {
					return
				}
			} else {
				if !writeSMTPLine(writer, "334 ") {
					return
				}
				awaitingAuth = true
			}
		case strings.HasPrefix(upper, "NOOP"):
			if !writeSMTPLine(writer, "250 2.0.0 ok") {
				return
			}
		case strings.HasPrefix(upper, "MAIL FROM:"):
			if !writeSMTPLine(writer, "250 2.1.0 sender ok") {
				return
			}
		case strings.HasPrefix(upper, "RCPT TO:"):
			if !writeSMTPLine(writer, "250 2.1.5 recipient ok") {
				return
			}
		case upper == "DATA":
			if !writeSMTPLine(writer, "354 3.0.0 end with <CRLF>.<CRLF>") {
				return
			}
			var body strings.Builder
			for {
				dataLine, readErr := reader.ReadString('\n')
				if readErr != nil {
					return
				}
				if dataLine == ".\r\n" || dataLine == ".\n" {
					break
				}
				if strings.HasPrefix(dataLine, "..") {
					dataLine = dataLine[1:]
				}
				body.WriteString(dataLine)
			}
			s.mu.Lock()
			s.body = body.String()
			s.mu.Unlock()
			s.dataStartedOnce.Do(func() { close(s.dataStarted) })
			if s.options.stallDataResponse {
				s.awaitBarrier()
			}
			if s.options.delayDataResponse > 0 {
				time.Sleep(s.options.delayDataResponse)
			}
			if !writeSMTPLine(writer, "250 2.0.0 queued synthetic-message") {
				return
			}
		case upper == "RSET":
			if !writeSMTPLine(writer, "250 2.0.0 reset") {
				return
			}
		case upper == "QUIT":
			if s.options.stallQuit {
				s.awaitBarrier()
			}
			_ = writeSMTPLine(writer, "221 2.0.0 closing connection")
			return
		default:
			if !writeSMTPLine(writer, "250 2.0.0 ok") {
				return
			}
		}
	}
}

func (s *syntheticSMTPServer) authFailureLine() string {
	if strings.TrimSpace(s.options.authErrorMessage) != "" {
		return s.options.authErrorMessage
	}
	return "535 5.7.8 synthetic secret authentication failure"
}

func (s *syntheticSMTPServer) writeGreetingExtensions(writer *bufio.Writer, tlsSeen bool) bool {
	lines := []string{"250-synthetic.local", "250-8BITMIME"}
	if s.options.advertiseStartTLS && !tlsSeen {
		lines = append(lines, "250-STARTTLS")
	}
	lines = append(lines, "250-AUTH PLAIN", "250 SIZE 1048576")
	for _, line := range lines {
		if !writeSMTPLine(writer, line) {
			return false
		}
	}
	return true
}

func (s *syntheticSMTPServer) validAuth(value string) bool {
	decoded, err := base64.StdEncoding.DecodeString(value)
	if err != nil {
		return false
	}
	want := "\x00" + s.options.authUser + "\x00" + s.options.authPassword
	return string(decoded) == want
}

func (s *syntheticSMTPServer) recordCommand(line string, tlsSeen bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.commands = append(s.commands, line)
	upper := strings.ToUpper(line)
	if strings.HasPrefix(upper, "STARTTLS") {
		s.startTLSOnce.Do(func() { close(s.startTLS) })
	}
	if strings.HasPrefix(upper, "AUTH ") {
		s.authStartOnce.Do(func() { close(s.authStart) })
		s.authSeen = true
		if !tlsSeen {
			s.authBeforeTLS = true
		}
	}
	if upper == "QUIT" {
		s.quitStartOnce.Do(func() { close(s.quitStart) })
	}
}

func (s *syntheticSMTPServer) markAuthSeen(tlsSeen bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.authSeen = true
	if !tlsSeen {
		s.authBeforeTLS = true
	}
}

func (s *syntheticSMTPServer) markAuthBeforeTLS() {
	s.mu.Lock()
	s.authBeforeTLS = true
	s.mu.Unlock()
}

func writeSMTPLine(writer *bufio.Writer, line string) bool {
	if _, err := writer.WriteString(line + "\r\n"); err != nil {
		return false
	}
	return writer.Flush() == nil
}

func newSyntheticTLSCertificate(t *testing.T) (tls.Certificate, *x509.CertPool) {
	t.Helper()
	caKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	caTemplate := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "DualLane synthetic CA"},
		NotBefore:             time.Now().Add(-time.Minute),
		NotAfter:              time.Now().Add(time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign | x509.KeyUsageDigitalSignature,
	}
	caDER, err := x509.CreateCertificate(rand.Reader, caTemplate, caTemplate, &caKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	caCertificate, err := x509.ParseCertificate(caDER)
	if err != nil {
		t.Fatal(err)
	}

	serverKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	serverTemplate := &x509.Certificate{
		SerialNumber: big.NewInt(2),
		Subject:      pkix.Name{CommonName: "127.0.0.1"},
		NotBefore:    time.Now().Add(-time.Minute),
		NotAfter:     time.Now().Add(time.Hour),
		DNSNames:     []string{"localhost"},
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	serverDER, err := x509.CreateCertificate(rand.Reader, serverTemplate, caCertificate, &serverKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	certificate, err := tls.X509KeyPair(
		pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: serverDER}),
		pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(serverKey)}),
	)
	if err != nil {
		t.Fatal(err)
	}
	rootCAs := x509.NewCertPool()
	rootCAs.AddCert(caCertificate)
	return certificate, rootCAs
}
