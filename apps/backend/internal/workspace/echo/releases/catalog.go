package releases

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

var versionPattern = regexp.MustCompile(`(?i)^(?:v)?(\d+\.\d+\.\d+)$`)

// LoadGuideCatalog reads the canonical shared catalog without modifying it.
// The caller supplies the path so cmd composition can select the checked-in
// asset for the current deployment.
func LoadGuideCatalog(path string) (GuideCatalog, error) {
	if strings.TrimSpace(path) == "" {
		return GuideCatalog{}, fmt.Errorf("%w: catalog path is required", ErrCatalogInvalid)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return GuideCatalog{}, fmt.Errorf("%w: catalog could not be loaded", ErrCatalogInvalid)
	}
	return ParseGuideCatalog(data)
}

// ParseGuideCatalog validates catalog JSON supplied by a trusted build asset.
// It is separate from LoadGuideCatalog so tests can use synthetic catalogs
// without copying or modifying the shared file.
func ParseGuideCatalog(data []byte) (GuideCatalog, error) {
	var guides []Guide
	if err := json.Unmarshal(data, &guides); err != nil {
		return GuideCatalog{}, fmt.Errorf("%w: catalog JSON is invalid", ErrCatalogInvalid)
	}
	return NewGuideCatalog(guides)
}

func NewGuideCatalog(guides []Guide) (GuideCatalog, error) {
	if len(guides) == 0 {
		return GuideCatalog{}, ErrCatalogEmpty
	}
	result := GuideCatalog{guides: make(map[string]Guide, len(guides))}
	for _, guide := range guides {
		normalized, err := normalizeGuide(guide)
		if err != nil {
			return GuideCatalog{}, fmt.Errorf("%w: guide validation failed", ErrCatalogInvalid)
		}
		if _, exists := result.guides[normalized.Version]; exists {
			return GuideCatalog{}, fmt.Errorf("%w: guide versions must be unique", ErrCatalogInvalid)
		}
		result.guides[normalized.Version] = normalized
	}
	return result, nil
}

func (c GuideCatalog) Guide(version string) (Guide, bool) {
	canonical, err := normalizeVersion(version)
	if err != nil {
		return Guide{}, false
	}
	guide, ok := c.guides[canonical]
	if !ok {
		return Guide{}, false
	}
	return cloneGuide(guide), true
}

func (c GuideCatalog) List() []Guide {
	versions := make([]string, 0, len(c.guides))
	for version := range c.guides {
		versions = append(versions, version)
	}
	sort.Strings(versions)
	result := make([]Guide, 0, len(versions))
	for _, version := range versions {
		result = append(result, cloneGuide(c.guides[version]))
	}
	return result
}

func normalizeGuide(value Guide) (Guide, error) {
	version, err := normalizeVersion(value.Version)
	if err != nil {
		return Guide{}, err
	}
	releasedAt, err := normalizeDate(value.ReleasedAt)
	if err != nil {
		return Guide{}, err
	}
	title, err := normalizeText(value.Title, 120)
	if err != nil {
		return Guide{}, err
	}
	summary, err := normalizeText(value.Summary, 500)
	if err != nil {
		return Guide{}, err
	}
	if len(value.Sections) < 1 || len(value.Sections) > 8 {
		return Guide{}, errorsGuideInvalid()
	}
	sections := make([]GuideSection, len(value.Sections))
	for sectionIndex, section := range value.Sections {
		sectionTitle, err := normalizeText(section.Title, 80)
		if err != nil {
			return Guide{}, err
		}
		if len(section.Items) < 1 || len(section.Items) > 12 {
			return Guide{}, errorsGuideInvalid()
		}
		items := make([]GuideItem, len(section.Items))
		for itemIndex, item := range section.Items {
			itemTitle, err := normalizeText(item.Title, 120)
			if err != nil {
				return Guide{}, err
			}
			description, err := normalizeText(item.Description, 800)
			if err != nil {
				return Guide{}, err
			}
			location, err := normalizeText(item.Location, 500)
			if err != nil {
				return Guide{}, err
			}
			items[itemIndex] = GuideItem{Title: itemTitle, Description: description, Location: location}
		}
		sections[sectionIndex] = GuideSection{Title: sectionTitle, Items: items}
	}
	return Guide{Version: version, ReleasedAt: releasedAt, Title: title, Summary: summary, Sections: sections}, nil
}

func normalizeVersion(value string) (string, error) {
	match := versionPattern.FindStringSubmatch(trimJavaScript(value))
	if len(match) != 2 {
		return "", validationError(CodeVersionInvalid, MessageVersionInvalid)
	}
	return match[1], nil
}

func normalizeDate(value string) (string, error) {
	text, err := normalizeText(value, 10)
	if err != nil {
		return "", err
	}
	parsed, err := time.Parse("2006-01-02", text)
	if err != nil || parsed.Format("2006-01-02") != text {
		return "", validationError(CodeGuideInvalid, MessageGuideInvalid)
	}
	return text, nil
}

func normalizeText(value string, maxCodePoints int) (string, error) {
	if !utf8.ValidString(value) {
		return "", errorsGuideInvalid()
	}
	text := trimJavaScript(value)
	if text == "" || utf8.RuneCountInString(text) > maxCodePoints || hasUnsafeControl(text) {
		return "", errorsGuideInvalid()
	}
	return text, nil
}

func hasUnsafeControl(value string) bool {
	for _, character := range value {
		if (character >= 0x00 && character <= 0x08) || character == 0x0b || character == 0x0c || (character >= 0x0e && character <= 0x1f) || (character >= 0x7f && character <= 0x9f) {
			return true
		}
	}
	return false
}

// trimJavaScript mirrors String.prototype.trim for the valid JSON strings
// accepted by the Node catalog loader. In particular, ECMAScript trims BOM
// (U+FEFF), while Go's strings.TrimSpace does not; both runtimes otherwise
// operate on the same Unicode scalar values for this catalog data.
func trimJavaScript(value string) string {
	runes := []rune(value)
	start := 0
	for start < len(runes) && isJavaScriptTrimSpace(runes[start]) {
		start++
	}
	end := len(runes)
	for end > start && isJavaScriptTrimSpace(runes[end-1]) {
		end--
	}
	return string(runes[start:end])
}

func isJavaScriptTrimSpace(value rune) bool {
	switch {
	case value >= 0x09 && value <= 0x0d:
		return true
	case value == 0x20 || value == 0xa0 || value == 0x1680 || value == 0x2028 || value == 0x2029 || value == 0x202f || value == 0x205f || value == 0x3000 || value == 0xfeff:
		return true
	case value >= 0x2000 && value <= 0x200a:
		return true
	default:
		return false
	}
}

func errorsGuideInvalid() error {
	return validationError(CodeGuideInvalid, MessageGuideInvalid)
}

func cloneGuide(guide Guide) Guide {
	clone := guide
	clone.Sections = make([]GuideSection, len(guide.Sections))
	for sectionIndex, section := range guide.Sections {
		clone.Sections[sectionIndex] = GuideSection{Title: section.Title, Items: append([]GuideItem(nil), section.Items...)}
	}
	return clone
}

func marshalGuide(guide Guide) ([]byte, string, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(guide); err != nil {
		return nil, "", err
	}
	data := bytes.TrimSuffix(buffer.Bytes(), []byte{'\n'})
	data = restoreNodeJSONLineSeparators(data)
	hash := sha256.Sum256(data)
	return data, hex.EncodeToString(hash[:]), nil
}

// Go's JSON encoder keeps HTML characters literal when SetEscapeHTML(false)
// is enabled, but still emits U+2028 and U+2029 as escapes. Node's
// JSON.stringify emits those two valid JSON characters literally. Restore only
// an actual JSON escape (not the second slash in a literal "\\u2028" value), so
// the stored bytes and hash remain compatible without introducing a general
// JSON rewriter.
func restoreNodeJSONLineSeparators(data []byte) []byte {
	result := make([]byte, 0, len(data))
	for index := 0; index < len(data); index++ {
		if index+5 < len(data) && data[index] == '\\' && (bytes.Equal(data[index+1:index+6], []byte("u2028")) || bytes.Equal(data[index+1:index+6], []byte("u2029"))) {
			slashes := 0
			for previous := index - 1; previous >= 0 && data[previous] == '\\'; previous-- {
				slashes++
			}
			if slashes%2 == 0 {
				if bytes.Equal(data[index+1:index+6], []byte("u2028")) {
					result = append(result, []byte("\u2028")...)
				} else {
					result = append(result, []byte("\u2029")...)
				}
				index += 5
				continue
			}
		}
		result = append(result, data[index])
	}
	return result
}

func parseStoredGuide(data []byte) (Guide, error) {
	var guide Guide
	if err := json.Unmarshal(data, &guide); err != nil {
		return Guide{}, fmt.Errorf("%w: stored guide JSON is invalid", ErrCatalogInvalid)
	}
	return normalizeGuide(guide)
}
