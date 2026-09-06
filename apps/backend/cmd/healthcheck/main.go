package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"time"
)

const (
	requestTimeout   = 3 * time.Second
	maxResponseBytes = 64 << 10
)

var errLoopbackOnly = errors.New("loopback health target required")

type healthPayload struct {
	OK    *bool   `json:"ok"`
	State *string `json:"state"`
}

func main() {
	if !run(os.Args[1:]) {
		os.Exit(1)
	}
}

func run(args []string) bool {
	target, path, ok := parseTarget(args)
	if !ok {
		return false
	}

	ctx, cancel := context.WithTimeout(context.Background(), requestTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return false
	}

	transport := &http.Transport{
		Proxy:                  nil,
		DialContext:            dialLoopback,
		DisableKeepAlives:      true,
		MaxResponseHeaderBytes: maxResponseBytes,
		ResponseHeaderTimeout:  requestTimeout,
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{
		Transport: transport,
		Timeout:   requestTimeout,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}

	response, err := client.Do(request)
	if err != nil {
		return false
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return false
	}

	body, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil || len(body) > maxResponseBytes {
		return false
	}
	var payload healthPayload
	if err := json.Unmarshal(body, &payload); err != nil || payload.OK == nil || !*payload.OK {
		return false
	}
	if path == "/readyz" && (payload.State == nil || *payload.State != "ready") {
		return false
	}
	return true
}

func parseTarget(args []string) (string, string, bool) {
	if len(args) != 1 {
		return "", "", false
	}
	target, err := url.Parse(args[0])
	if err != nil || target.Scheme != "http" || target.Opaque != "" || target.Host == "" || target.User != nil || target.RawQuery != "" || target.ForceQuery || target.Fragment != "" || target.RawPath != "" {
		return "", "", false
	}
	if target.Path != "/api/health" && target.Path != "/readyz" {
		return "", "", false
	}
	port, err := strconv.Atoi(target.Port())
	if err != nil || port < 1 || port > 65535 {
		return "", "", false
	}
	ip := net.ParseIP(target.Hostname())
	if ip == nil || !ip.IsLoopback() {
		return "", "", false
	}
	return target.String(), target.Path, true
}

func dialLoopback(ctx context.Context, network, address string) (net.Conn, error) {
	if network != "tcp" && network != "tcp4" && network != "tcp6" {
		return nil, errLoopbackOnly
	}
	host, portText, err := net.SplitHostPort(address)
	if err != nil {
		return nil, errLoopbackOnly
	}
	ip := net.ParseIP(host)
	port, err := strconv.Atoi(portText)
	if ip == nil || !ip.IsLoopback() || err != nil || port < 1 || port > 65535 {
		return nil, errLoopbackOnly
	}
	dialer := net.Dialer{Timeout: requestTimeout}
	return dialer.DialContext(ctx, network, net.JoinHostPort(ip.String(), strconv.Itoa(port)))
}
