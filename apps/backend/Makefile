GO ?= go

.PHONY: test test-race vet staticcheck vuln build generate check-generated integration-postgres verify

generate:
	$(GO) generate ./internal/p2pcontract
	$(GO) tool sqlc generate --no-remote

check-generated:
	$(GO) test -count=1 ./internal/p2pcontract -run '^TestGeneratedP2PContractIsFresh$$'
	$(GO) tool sqlc diff --no-remote

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

verify: check-generated test test-race vet staticcheck vuln build
