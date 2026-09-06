GO ?= go
NODE ?= node

.PHONY: test test-race vet staticcheck vuln build generate check-generated parity-p2p integration-postgres verify

generate:
	$(GO) generate ./internal/p2pcontract
	$(GO) tool sqlc generate --no-remote

check-generated:
	$(GO) test -count=1 ./internal/p2pcontract -run '^TestGeneratedP2PContractIsFresh$$'
	$(GO) tool sqlc diff --no-remote

# Run both implementations in the same OS with a disposable, CGO-free binary.
parity-p2p:
	@set -eu; \
	binary_dir=$$(mktemp -d); \
	trap 'rm -f "$$binary_dir/p2p"; rmdir "$$binary_dir"' EXIT; \
	CGO_ENABLED=0 $(GO) build -o "$$binary_dir/p2p" ./cmd/p2p; \
	cd ../..; \
	$(NODE) scripts/backend/p2p-parity.mjs --go-binary "$$binary_dir/p2p"

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
