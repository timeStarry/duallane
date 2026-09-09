package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadS3CredentialsPreservesNodeSecretContract(t *testing.T) {
	path := filepath.Join(t.TempDir(), "workspace-s3.json")
	if err := os.WriteFile(path, []byte(`{"accessKey":" access ","secretKey":" secret ","ignored":true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	credentials, err := LoadS3Credentials(path)
	if err != nil {
		t.Fatal(err)
	}
	if credentials.AccessKey != "access" || credentials.SecretKey != "secret" {
		t.Fatalf("credentials = %#v", credentials)
	}
}

func TestLoadS3CredentialsBoundsAndRedactsFailures(t *testing.T) {
	directory := t.TempDir()
	secret := "must-not-appear"
	cases := map[string][]byte{
		"invalid.json": []byte(`{"accessKey":"` + secret + `"`),
		"empty.json":   []byte(`{"accessKey":"","secretKey":""}`),
		"large.json":   []byte(strings.Repeat("x", int(maximumS3CredentialsBytes)+1)),
	}
	for name, content := range cases {
		path := filepath.Join(directory, name)
		if err := os.WriteFile(path, content, 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := LoadS3Credentials(path); err == nil || strings.Contains(err.Error(), path) || strings.Contains(err.Error(), secret) {
			t.Fatalf("unsafe error for %s: %v", name, err)
		}
	}
}
