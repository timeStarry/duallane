package emotes

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
)

var defaultHiddenPackIDs = map[string]struct{}{
	"douyin": {},
	"qq":     {},
}

// Catalog is an immutable, process-local view of the imported built-in
// catalog. The constructor copies caller-owned slices so a handler cannot
// mutate the registry while another request is validating a reaction.
type Catalog struct {
	packs  []CatalogPack
	byKey  map[string]CatalogItem
	hidden map[string]struct{}
}

// NewCatalog builds a catalog from decoded packs. Duplicate pack/item IDs are
// rejected instead of silently changing which built-in is returned.
func NewCatalog(packs []CatalogPack) (*Catalog, error) {
	return NewCatalogWithHiddenPacks(packs, nil)
}

func NewCatalogWithHiddenPacks(packs []CatalogPack, hiddenPackIDs []string) (*Catalog, error) {
	hidden := make(map[string]struct{}, len(defaultHiddenPackIDs)+len(hiddenPackIDs))
	for id := range defaultHiddenPackIDs {
		hidden[id] = struct{}{}
	}
	for _, value := range hiddenPackIDs {
		value = strings.TrimSpace(value)
		if value != "" {
			hidden[value] = struct{}{}
		}
	}
	copyPacks := make([]CatalogPack, len(packs))
	byKey := make(map[string]CatalogItem)
	seenPacks := make(map[string]struct{}, len(packs))
	for index, pack := range packs {
		pack.ID = strings.TrimSpace(pack.ID)
		pack.Label = strings.TrimSpace(pack.Label)
		if pack.ID == "" || pack.Label == "" {
			return nil, errors.New("catalog pack id and label are required")
		}
		if _, exists := seenPacks[pack.ID]; exists {
			return nil, fmt.Errorf("duplicate catalog pack %q", pack.ID)
		}
		seenPacks[pack.ID] = struct{}{}
		if pack.DefaultEnabled == nil {
			enabled := true
			pack.DefaultEnabled = &enabled
		}
		pack.Items = append([]CatalogItem(nil), pack.Items...)
		seenItems := make(map[string]struct{}, len(pack.Items))
		for itemIndex, item := range pack.Items {
			item.ID = strings.TrimSpace(item.ID)
			item.Kind = strings.TrimSpace(item.Kind)
			item.Label = strings.TrimSpace(item.Label)
			if item.ID == "" || item.Label == "" || (item.Kind != "unicode" && item.Kind != "image") {
				return nil, fmt.Errorf("invalid catalog item %q:%q", pack.ID, item.ID)
			}
			if _, exists := seenItems[item.ID]; exists {
				return nil, fmt.Errorf("duplicate catalog item %q:%q", pack.ID, item.ID)
			}
			seenItems[item.ID] = struct{}{}
			if item.Kind == "unicode" && item.Value == "" {
				return nil, fmt.Errorf("unicode catalog item %q:%q has no value", pack.ID, item.ID)
			}
			if item.Kind == "image" && (item.Src == "" || item.Token == "") {
				return nil, fmt.Errorf("image catalog item %q:%q has no src or token", pack.ID, item.ID)
			}
			pack.Items[itemIndex] = item
			key := pack.ID + ":" + item.ID
			if _, exists := byKey[key]; exists {
				return nil, fmt.Errorf("duplicate catalog key %q", key)
			}
			byKey[key] = item
		}
		copyPacks[index] = pack
	}
	return &Catalog{packs: copyPacks, byKey: byKey, hidden: hidden}, nil
}

// LoadCatalog decodes the same JSON shape used by apps/web/shared.
func LoadCatalog(reader io.Reader) (*Catalog, error) {
	if reader == nil {
		return nil, errors.New("catalog reader is required")
	}
	var packs []CatalogPack
	decoder := json.NewDecoder(reader)
	if err := decoder.Decode(&packs); err != nil {
		return nil, fmt.Errorf("decode emote catalog: %w", err)
	}
	return NewCatalog(packs)
}

func LoadCatalogFile(path string) (*Catalog, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open emote catalog: %w", err)
	}
	defer file.Close()
	return LoadCatalog(file)
}

func (catalog *Catalog) Lookup(key string) (CatalogItem, bool) {
	if catalog == nil {
		return CatalogItem{}, false
	}
	item, ok := catalog.byKey[strings.TrimSpace(key)]
	return item, ok
}

func (catalog *Catalog) IsVisible(key string) bool {
	packID, _, ok := strings.Cut(strings.TrimSpace(key), ":")
	if !ok || catalog == nil {
		return false
	}
	if _, hidden := catalog.hidden[packID]; hidden {
		return false
	}
	_, exists := catalog.byKey[strings.TrimSpace(key)]
	return exists
}

func (catalog *Catalog) Public(key string) *PublicCatalogEmote {
	item, ok := catalog.Lookup(key)
	if !ok {
		return nil
	}
	packID, _, ok := strings.Cut(strings.TrimSpace(key), ":")
	if !ok {
		return nil
	}
	if _, hidden := catalog.hidden[packID]; hidden {
		return nil
	}
	result := &PublicCatalogEmote{EmoteKey: strings.TrimSpace(key), Kind: item.Kind, Label: item.Label}
	if item.Kind == "unicode" {
		result.Value = item.Value
	} else {
		result.Src = item.Src
	}
	return result
}

func (catalog *Catalog) VisibleReactionKeys() []string {
	if catalog == nil {
		return []string{}
	}
	result := make([]string, 0, len(catalog.byKey))
	for _, pack := range catalog.packs {
		if _, hidden := catalog.hidden[pack.ID]; hidden {
			continue
		}
		for _, item := range pack.Items {
			result = append(result, pack.ID+":"+item.ID)
		}
	}
	return result
}

func (catalog *Catalog) VisiblePacks() []PublicCatalogPack {
	if catalog == nil {
		return []PublicCatalogPack{}
	}
	result := make([]PublicCatalogPack, 0, len(catalog.packs))
	for _, pack := range catalog.packs {
		if _, hidden := catalog.hidden[pack.ID]; hidden {
			continue
		}
		defaultEnabled := pack.DefaultEnabled == nil || *pack.DefaultEnabled
		result = append(result, PublicCatalogPack{ID: pack.ID, Label: pack.Label, DefaultEnabled: defaultEnabled})
	}
	return result
}

func (catalog *Catalog) Image(key string) (CatalogItem, bool) {
	item, ok := catalog.Lookup(key)
	if !ok || item.Kind != "image" || !catalog.IsVisible(key) {
		return CatalogItem{}, false
	}
	return item, true
}
