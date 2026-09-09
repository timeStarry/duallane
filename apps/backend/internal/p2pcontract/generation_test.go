package p2pcontract

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestGeneratedP2PContractIsFresh(t *testing.T) {
	packageDir, err := os.Getwd()
	if err != nil {
		t.Fatalf("get p2pcontract package directory: %v", err)
	}

	outputPath := filepath.Join(t.TempDir(), "p2p.gen.go")
	configPath := filepath.Join(packageDir, "..", "..", "api", "p2p.codegen.yaml")
	specPath := filepath.Join(packageDir, "..", "..", "api", "p2p.yaml")
	goBinary, err := exec.LookPath("go")
	if err != nil {
		t.Fatalf("find Go executable on PATH: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	command := exec.CommandContext(ctx, goBinary, "tool", "oapi-codegen", "--config", configPath, "-o", outputPath, specPath)
	command.Dir = packageDir
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("regenerate P2P contract: %v\n%s", err, output)
	}

	generated, err := os.ReadFile(outputPath)
	if err != nil {
		t.Fatalf("read regenerated P2P contract: %v", err)
	}
	checkedIn, err := os.ReadFile(filepath.Join(packageDir, "p2p.gen.go"))
	if err != nil {
		t.Fatalf("read checked-in P2P contract: %v", err)
	}
	if !bytes.Equal(normalizeGeneratedLineEndings(generated), normalizeGeneratedLineEndings(checkedIn)) {
		t.Fatal("p2p.gen.go is stale; run go generate ./internal/p2pcontract with the pinned tool")
	}
}

func normalizeGeneratedLineEndings(data []byte) []byte {
	return bytes.ReplaceAll(data, []byte("\r\n"), []byte("\n"))
}
