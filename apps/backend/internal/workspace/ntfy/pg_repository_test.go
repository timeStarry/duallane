package ntfy

import (
	"errors"
	"strings"
	"testing"
)

func TestPGRepositoryBindTxRejectsMissingTransaction(t *testing.T) {
	repository := NewPGRepository(nil)

	bound, err := repository.BindTx(nil)
	var domainErr *Error
	if !errors.As(err, &domainErr) || !strings.Contains(domainErr.Cause.Error(), "postgres transaction is required") {
		t.Fatalf("expected missing transaction error, got bound=%T err=%v", bound, err)
	}
}

func TestPGRepositoryBindTxRejectsMissingRepository(t *testing.T) {
	var repository *PGRepository

	bound, err := repository.BindTx(nil)
	var domainErr *Error
	if !errors.As(err, &domainErr) || !strings.Contains(domainErr.Cause.Error(), "repository is required") {
		t.Fatalf("expected missing repository error, got bound=%T err=%v", bound, err)
	}
}
