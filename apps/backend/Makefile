GO ?= go

.PHONY: test test-race vet staticcheck vuln build integration-postgres verify

test:
	$(GO) test ./...

test-race:
	$(GO) test -race ./...

vet:
	$(GO) vet ./...

staticcheck:
	$(GO) tool staticcheck ./...

vuln:
	$(GO) tool govulncheck ./...

build:
	$(GO) build ./cmd/...

integration-postgres:
	@test -n "$(TEST_DATABASE_URL)" || (echo "TEST_DATABASE_URL is required" >&2; exit 2)
	$(GO) test -count=1 -race -tags postgres_integration ./...

verify: test test-race vet staticcheck vuln build
