package releases

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"unicode/utf8"
)

type nodeReleaseFixture struct {
	Catalog   []nodeCatalogFixture `json:"catalog"`
	Synthetic nodeSyntheticFixture `json:"synthetic"`
}

type nodeCatalogFixture struct {
	Version       string   `json:"version"`
	GuideJSON     string   `json:"guideJSON"`
	GuideHash     string   `json:"guideHash"`
	PublicationID string   `json:"publicationID"`
	DeliveryIDs   []string `json:"deliveryIDs"`
	LockKey       string   `json:"lockKey"`
}

type nodeSyntheticFixture struct {
	Version       string                   `json:"version"`
	GuideJSON     string                   `json:"guideJSON"`
	GuideHash     string                   `json:"guideHash"`
	PublicationID string                   `json:"publicationID"`
	DeliveryIDs   []string                 `json:"deliveryIDs"`
	LockKey       string                   `json:"lockKey"`
	Errors        map[string]nodeErrorData `json:"errors"`
	Probe         nodeStringProbe          `json:"utf16AndCodePointProbe"`
}

type nodeErrorData struct {
	Code       string `json:"code"`
	Message    string `json:"message"`
	StatusCode int    `json:"statusCode"`
}

type nodeStringProbe struct {
	EmojiCodePoints  int  `json:"emojiCodePoints"`
	EmojiUTF16Length int  `json:"emojiUTF16Length"`
	BOMTrimmed       bool `json:"bomTrimmed"`
}

func loadNodeReleaseFixture(t *testing.T) nodeReleaseFixture {
	t.Helper()
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	data, err := os.ReadFile(filepath.Join(filepath.Dir(sourceFile), "testdata", "node-release-fixtures.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture nodeReleaseFixture
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	return fixture
}

func TestNodeCatalogGuideSnapshotsAndHashesMatch(t *testing.T) {
	fixture := loadNodeReleaseFixture(t)
	catalog := sharedReleaseCatalog(t)
	if len(fixture.Catalog) != len(catalog.List()) {
		t.Fatalf("Node catalog versions=%d Go catalog versions=%d", len(fixture.Catalog), len(catalog.List()))
	}
	for _, expected := range fixture.Catalog {
		guide, ok := catalog.Guide("V" + expected.Version)
		if !ok {
			t.Fatalf("catalog missing version %s", expected.Version)
		}
		data, hash, err := marshalGuide(guide)
		if err != nil {
			t.Fatal(err)
		}
		if string(data) != expected.GuideJSON {
			t.Fatalf("Node guide JSON mismatch for %s\nwant %s\ngot  %s", expected.Version, expected.GuideJSON, string(data))
		}
		if hash != expected.GuideHash {
			t.Fatalf("Node guide hash mismatch for %s: want %s got %s", expected.Version, expected.GuideHash, hash)
		}
		if !strings.HasPrefix(expected.PublicationID, "echo_release_") {
			t.Fatalf("Node publication ID %q lacks echo_release_ prefix", expected.PublicationID)
		}
		if len(expected.DeliveryIDs) != 2 {
			t.Fatalf("Node fixture recipient count for %s = %d", expected.Version, len(expected.DeliveryIDs))
		}
		for _, deliveryID := range expected.DeliveryIDs {
			if !strings.HasPrefix(deliveryID, "echo_release_delivery_") {
				t.Fatalf("Node delivery ID %q lacks echo_release_delivery_ prefix", deliveryID)
			}
		}
		wantLock := "duallane:echo-release:spc_fixture:" + expected.Version
		if expected.LockKey != wantLock {
			t.Fatalf("Node lock key for %s = %q, want %q", expected.Version, expected.LockKey, wantLock)
		}
	}
}

func TestNodeNormalizationAndEdgeGuideSnapshotMatch(t *testing.T) {
	fixture := loadNodeReleaseFixture(t)
	if fixture.Synthetic.Probe.EmojiCodePoints != 1 || fixture.Synthetic.Probe.EmojiUTF16Length != 2 || !fixture.Synthetic.Probe.BOMTrimmed {
		t.Fatalf("unexpected Node normalization probe: %#v", fixture.Synthetic.Probe)
	}
	if _, err := normalizeVersion("V1.2.3"); err != nil {
		t.Fatalf("uppercase V was rejected: %v", err)
	}
	if got := trimJavaScript("\ufeff value\ufeff"); got != "value" {
		t.Fatalf("BOM trim = %q", got)
	}
	if got := utf8.RuneCountInString("😀"); got != fixture.Synthetic.Probe.EmojiCodePoints {
		t.Fatalf("Go code point count=%d Node code point count=%d", got, fixture.Synthetic.Probe.EmojiCodePoints)
	}

	var edge Guide
	if err := json.Unmarshal([]byte(fixture.Synthetic.GuideJSON), &edge); err != nil {
		t.Fatal(err)
	}
	normalized, err := normalizeGuide(edge)
	if err != nil {
		t.Fatal(err)
	}
	data, hash, err := marshalGuide(normalized)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != fixture.Synthetic.GuideJSON || hash != fixture.Synthetic.GuideHash {
		t.Fatalf("synthetic Node guide snapshot/hash mismatch\nwant %s\ngot  %s", fixture.Synthetic.GuideJSON, string(data))
	}
	for _, value := range []string{"<>&", "\u2028", "\u2029", "\\\\"} {
		if !strings.Contains(string(data), value) {
			t.Fatalf("synthetic JSON does not preserve %q: %q", value, string(data))
		}
	}
	literalEscapeGuide := normalized
	literalEscapeGuide.Title = `literal \u2028`
	literalEscapeGuide, err = normalizeGuide(literalEscapeGuide)
	if err != nil {
		t.Fatal(err)
	}
	literalData, _, err := marshalGuide(literalEscapeGuide)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(literalData), `\\u2028`) || strings.Contains(string(literalData), "\u2028") {
		t.Fatalf("literal backslash escape was rewritten: %q", string(literalData))
	}
	if fixture.Synthetic.PublicationID != "echo_release_node-edge-001" || len(fixture.Synthetic.DeliveryIDs) != 2 || fixture.Synthetic.LockKey != "duallane:echo-release:spc_fixture:1.2.3" {
		t.Fatalf("synthetic publication contract drift: %#v", fixture.Synthetic)
	}
	for _, deliveryID := range fixture.Synthetic.DeliveryIDs {
		if !strings.HasPrefix(deliveryID, "echo_release_delivery_") {
			t.Fatalf("synthetic delivery ID %q lacks Node prefix", deliveryID)
		}
	}
	if got := fixture.Synthetic.Errors["missingActor"]; got.Code != CodePermissionDenied || got.Message != MessageUnauthorized || got.StatusCode != 403 {
		t.Fatalf("Node missing actor error = %#v", got)
	}
	if got := fixture.Synthetic.Errors["nonOwner"]; got.Code != CodePermissionDenied || got.Message != MessagePermissionDenied || got.StatusCode != 403 {
		t.Fatalf("Node non-owner error = %#v", got)
	}
}
