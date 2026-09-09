package messages

import (
	"encoding/json"
	"errors"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

const (
	DefaultSpaceID           = "spc_default"
	MessageContentFormat     = "duallane.message+json;v=1"
	DefaultRetentionCount    = int64(10000)
	DefaultListLimit         = 80
	MaxListLimit             = 200
	MaxMessageTextCodePoints = 30000
	MaxMessageTextBytes      = 100 * 1024
	DefaultRecallReason      = "内容有误"
)

var (
	emojiShortcodePattern = regexp.MustCompile(`^[a-z0-9_+\-]{1,64}$`)
	reactionKeyPattern    = regexp.MustCompile(`^[a-z0-9_+\-]{1,64}:[a-z0-9_+\-]{1,128}$`)
)

// Content is the versioned message content envelope. PlainText is server
// generated for persisted messages; callers' supplied value is ignored.
type Content struct {
	Format    string  `json:"format"`
	PlainText string  `json:"plainText"`
	Blocks    []Block `json:"blocks"`
}

// Block covers the Workspace v1 protocol blocks. Fields outside the selected
// block type are omitted when the server canonicalizes the content.
type Block struct {
	Type         string `json:"type"`
	Text         string `json:"text,omitempty"`
	UserID       string `json:"userId,omitempty"`
	Label        string `json:"label,omitempty"`
	URL          string `json:"url,omitempty"`
	Shortcode    string `json:"shortcode,omitempty"`
	AttachmentID string `json:"attachmentId,omitempty"`
	ShareID      string `json:"shareId,omitempty"`
	// Share is a server-hydrated read projection. Message writes accept and
	// persist only ShareID; callers must never treat this field as input.
	Share         *EmoteCollectionShare `json:"share,omitempty"`
	TopicID       string                `json:"topicId,omitempty"`
	Title         string                `json:"title,omitempty"`
	CardID        string                `json:"cardId,omitempty"`
	CardType      string                `json:"cardType,omitempty"`
	SchemaVersion int                   `json:"schemaVersion,omitempty"`
	FallbackText  string                `json:"fallbackText,omitempty"`
}

// EmoteCollectionSharePerson is the viewer-specific public identity used by
// a message's share snapshot. It deliberately contains no account metadata.
type EmoteCollectionSharePerson struct {
	ID          string `json:"id"`
	DisplayName string `json:"displayName"`
}

// EmoteCollectionShareCover is the small cover projection shown in a message.
// Custom covers expose only their content endpoint; storage keys and digests
// never cross this boundary. Built-in covers are resolved from the trusted
// process catalog by the repository adapter.
type EmoteCollectionShareCover struct {
	ID       string `json:"id"`
	Label    string `json:"label"`
	Src      string `json:"src"`
	Animated *bool  `json:"animated,omitempty"`
}

// EmoteCollectionShare is the Node-compatible message share projection. A
// revoked share remains visible when it is referenced by a message, but its
// covers are empty because revocation removes share items. An unreferenced or
// unknown share is never returned by the message projection.
type EmoteCollectionShare struct {
	ID              string                      `json:"id"`
	Name            string                      `json:"name"`
	ItemCount       int                         `json:"itemCount"`
	CreatedAt       string                      `json:"createdAt"`
	RevokedAt       *string                     `json:"revokedAt"`
	SharedBy        EmoteCollectionSharePerson  `json:"sharedBy"`
	OriginalCreator EmoteCollectionSharePerson  `json:"originalCreator"`
	CanRevoke       bool                        `json:"canRevoke"`
	Covers          []EmoteCollectionShareCover `json:"covers"`
	SharePath       string                      `json:"sharePath"`
}

type MentionMember struct {
	ID          string
	DisplayName string
	Nickname    string
	GitHubLogin string
	Kind        string
}

type AttachmentRecord struct {
	ID             string
	SpaceID        string
	UploaderID     string
	UploaderName   string
	ConversationID *string
	Visibility     string
	Status         string
	FileName       string
	MIMEType       string
	ByteSize       int64
	CreatedAt      time.Time
	CompletedAt    *time.Time
}

type AttachmentCapabilities struct {
	CanDownload bool `json:"canDownload"`
	CanRemove   bool `json:"canRemove"`
}

type PublicUploader struct {
	ID          string `json:"id"`
	DisplayName string `json:"displayName"`
}

// Attachment is the server-owned message attachment projection. Internal
// storage keys, digests, transfer IDs, and ledger rows are intentionally not
// represented here.
type Attachment struct {
	ID             string                 `json:"id"`
	FileName       string                 `json:"fileName"`
	MIMEType       string                 `json:"mimeType"`
	ByteSize       int64                  `json:"byteSize"`
	Status         string                 `json:"status"`
	Visibility     string                 `json:"visibility"`
	UploaderID     string                 `json:"uploaderId"`
	UploaderName   string                 `json:"uploaderName"`
	Uploader       PublicUploader         `json:"uploader"`
	ConversationID *string                `json:"conversationId"`
	CreatedAt      string                 `json:"createdAt"`
	CompletedAt    *string                `json:"completedAt"`
	AvailableAt    *string                `json:"availableAt"`
	Capabilities   AttachmentCapabilities `json:"capabilities"`
}

type ReactionUser struct {
	ID          string `json:"id"`
	DisplayName string `json:"displayName"`
	GitHubLogin string `json:"githubLogin,omitempty"`
	AvatarURL   string `json:"avatarUrl,omitempty"`
	CreatedAt   string `json:"createdAt"`
}

type ReactionGroup struct {
	EmoteKey             string         `json:"emoteKey"`
	Count                int            `json:"count"`
	ReactedByCurrentUser bool           `json:"reactedByCurrentUser"`
	Users                []ReactionUser `json:"users"`
}

// Message is the safe product projection. Sequence and Revision stay out of
// the public projection because the current HTTP contract does not expose
// persistence cursors or internal compare-and-swap state.
type Message struct {
	ID                  string          `json:"id"`
	ConversationID      string          `json:"conversationId"`
	AuthorID            *string         `json:"authorId"`
	AuthorName          string          `json:"authorName"`
	AuthorNickname      string          `json:"authorNickname,omitempty"`
	AuthorRemark        string          `json:"authorRemark,omitempty"`
	AuthorGitHubLogin   string          `json:"authorGithubLogin,omitempty"`
	AuthorAvatarURL     string          `json:"authorAvatarUrl,omitempty"`
	AuthorKind          string          `json:"authorKind"`
	Kind                string          `json:"kind"`
	ClientMessageID     *string         `json:"clientMessageId"`
	Content             Content         `json:"content"`
	PlainText           string          `json:"plainText"`
	ReplyToMessageID    *string         `json:"replyToMessageId"`
	CreatedAt           string          `json:"createdAt"`
	EditedAt            *string         `json:"editedAt"`
	DeletedAt           *string         `json:"deletedAt"`
	RecalledAt          *string         `json:"recalledAt"`
	RecallReason        *string         `json:"recallReason"`
	Attachments         []Attachment    `json:"attachments"`
	Reactions           []ReactionGroup `json:"reactions"`
	HiddenByCurrentUser bool            `json:"hiddenByCurrentUser"`
	Pin                 *MessagePin     `json:"pin,omitempty"`
}

// MessagePin is a viewer-scoped read projection. Pin mutation and authorization
// remain owned by the conversations service; no write input accepts this DTO.
type MessagePin struct {
	PinnedByUserID string `json:"pinnedByUserId"`
	PinnedAt       string `json:"pinnedAt"`
	CanUnpin       bool   `json:"canUnpin"`
}

// MessageRecord is a storage projection and must not be returned directly by
// a transport. EventSeq is the latest persisted event sequence for the row;
// Revision is derived from the existing recalled state until a future additive
// migration gives messages an explicit revision column.
type MessageRecord struct {
	ID                  string
	SpaceID             string
	ConversationID      string
	AuthorID            *string
	AuthorName          string
	AuthorNickname      string
	AuthorRemark        string
	AuthorGitHubLogin   string
	AuthorAvatarURL     string
	AuthorKind          string
	Kind                string
	ClientMessageID     *string
	ContentJSON         []byte
	PlainText           string
	ReplyToMessageID    *string
	CreatedAt           time.Time
	EditedAt            *time.Time
	DeletedAt           *time.Time
	RecalledAt          *time.Time
	RecallReason        *string
	HiddenByCurrentUser bool
	PinnedByUserID      *string
	PinnedAt            *time.Time
	// EmoteCollectionShares is populated only by an authorized read adapter.
	// It is not persisted and is intentionally absent from write inputs.
	EmoteCollectionShares map[string]EmoteCollectionShare
	EventSeq              int64
	Revision              int64
}

type ConversationRecord struct {
	ID             string
	SpaceID        string
	Type           string
	RetentionCount int64
	CreatedAt      time.Time
}

type ListOptions struct {
	SpaceID        string
	ActorID        string
	ConversationID string
	Meta           RequestMeta
	Before         string
	After          string
	Around         string
	Limit          int
}

type CreateInput struct {
	ActorID          string
	ConversationID   string
	ClientMessageID  string
	Content          Content
	ReplyToMessageID string
	Meta             RequestMeta
}

type RecallInput struct {
	ActorID          string
	MessageID        string
	ExpectedRevision int64
	Meta             RequestMeta
}

type HideInput struct {
	ActorID   string
	MessageID string
	Meta      RequestMeta
}

type ReactionInput struct {
	ActorID   string
	MessageID string
	EmoteKey  string
	Meta      RequestMeta
}

type HideResult struct {
	MessageID string `json:"messageId"`
	Hidden    bool   `json:"hidden"`
	Changed   bool   `json:"changed"`
}

type ReactionResult struct {
	MessageID string          `json:"messageId"`
	Reactions []ReactionGroup `json:"reactions"`
	Created   bool            `json:"-"`
	Removed   bool            `json:"-"`
}

type MessageInsert struct {
	ID               string
	SpaceID          string
	ConversationID   string
	AuthorID         string
	AuthorKind       string
	Kind             string
	ClientMessageID  string
	ContentFormat    string
	ContentJSON      []byte
	PlainText        string
	ReplyToMessageID *string
	CreatedAt        time.Time
}

type EventInput struct {
	ID             string
	SpaceID        string
	Type           string
	ActorID        string
	ConversationID string
	TargetType     string
	TargetID       string
	PayloadJSON    []byte
	CreatedAt      time.Time
}

type EventRecord struct {
	ID      string
	SpaceID string
	Seq     int64
}

type AuditInput struct {
	ID               string
	SpaceID          string
	ActorUserID      string
	ActorGitHubLogin string
	Action           string
	TargetType       string
	TargetID         string
	Result           string
	Reason           string
	RequestID        string
	IPAddress        string
	UserAgent        string
	CreatedAt        time.Time
}

// RequestMeta deliberately aliases auth.RequestMeta so every workspace
// vertical uses the same Safe() redaction rules for audit context.
type RequestMeta = auth.RequestMeta

// ProjectMessage converts the storage record and already-authorized related
// rows into the one reusable public message projection. It does not perform
// authorization or query other domains; callers must provide only rows the
// current viewer may see.
func ProjectMessage(record MessageRecord, attachments []AttachmentRecord, reactions []ReactionGroup) (Message, error) {
	return projectMessage(record, attachments, reactions, nil)
}

// ProjectMessageForViewer adds the viewer-bound attachment capabilities and
// uploader display name to the otherwise shared message projection. Related
// rows must already have been authorized by the caller; this function does
// not perform domain reads or authorization itself.
func ProjectMessageForViewer(record MessageRecord, attachments []AttachmentRecord, reactions []ReactionGroup, viewer *auth.Actor) (Message, error) {
	return projectMessage(record, attachments, reactions, viewer)
}

func projectMessage(record MessageRecord, attachments []AttachmentRecord, reactions []ReactionGroup, viewer *auth.Actor) (Message, error) {
	authorName := firstNonEmpty(record.AuthorRemark, record.AuthorNickname, record.AuthorGitHubLogin, record.AuthorName)
	if authorName == "" {
		if record.AuthorKind == "bot" {
			authorName = "Bot"
		} else {
			authorName = "成员"
		}
	}

	message := Message{
		ID:                  record.ID,
		ConversationID:      record.ConversationID,
		AuthorID:            stringPointer(record.AuthorID),
		AuthorName:          authorName,
		AuthorNickname:      record.AuthorNickname,
		AuthorRemark:        record.AuthorRemark,
		AuthorGitHubLogin:   record.AuthorGitHubLogin,
		AuthorAvatarURL:     sanitizeMessageAvatar(record.AuthorAvatarURL),
		AuthorKind:          record.AuthorKind,
		Kind:                record.Kind,
		ClientMessageID:     stringPointer(record.ClientMessageID),
		ReplyToMessageID:    stringPointer(record.ReplyToMessageID),
		CreatedAt:           formatTimestamp(record.CreatedAt),
		EditedAt:            formatNullableTimestamp(record.EditedAt),
		DeletedAt:           formatNullableTimestamp(record.DeletedAt),
		RecalledAt:          formatNullableTimestamp(record.RecalledAt),
		RecallReason:        nil,
		Attachments:         make([]Attachment, 0, len(attachments)),
		Reactions:           cloneReactionGroups(reactions),
		HiddenByCurrentUser: record.HiddenByCurrentUser,
	}
	if record.AuthorKind != "human" {
		message.AuthorNickname = ""
		message.AuthorRemark = ""
		message.AuthorGitHubLogin = ""
	}

	if record.RecalledAt != nil && !record.RecalledAt.IsZero() {
		reason := firstNonEmptyPtr(record.RecallReason, DefaultRecallReason)
		message.Content = Content{
			Format:    MessageContentFormat,
			PlainText: "",
			Blocks:    make([]Block, 0),
		}
		message.PlainText = authorName + "因" + reason + "撤回了一条消息"
		message.RecalledAt = formatNullableTimestamp(record.RecalledAt)
		message.RecallReason = stringPointer(&reason)
		message.ReplyToMessageID = nil
		message.Attachments = make([]Attachment, 0)
		message.Reactions = make([]ReactionGroup, 0)
		return message, nil
	}

	content, err := projectContent(record.ContentJSON, record.PlainText, record.EmoteCollectionShares)
	if err != nil {
		return Message{}, err
	}
	message.Content = content
	message.PlainText = content.PlainText
	if record.PinnedByUserID != nil && record.PinnedAt != nil && !record.PinnedAt.IsZero() {
		message.Pin = &MessagePin{
			PinnedByUserID: *record.PinnedByUserID,
			PinnedAt:       formatTimestamp(*record.PinnedAt),
			CanUnpin: viewer != nil && (viewer.Role == "owner" || viewer.Role == "admin" ||
				(record.AuthorID != nil && viewer.ID == *record.AuthorID)),
		}
	}
	for _, attachment := range attachments {
		message.Attachments = append(message.Attachments, projectAttachment(attachment, viewer))
	}
	return message, nil
}

// ProjectContent is the shared read-only content projection used by message
// HTTP, conversation pin/latest-message, and realtime event readers. The
// shares map must come from the message junction query; client content is not
// a source of share metadata.
func ProjectContent(raw []byte, fallbackPlainText string, shares map[string]EmoteCollectionShare) (Content, error) {
	return projectContent(raw, fallbackPlainText, shares)
}

func projectContent(raw []byte, fallbackPlainText string, shares map[string]EmoteCollectionShare) (Content, error) {
	content := Content{
		Format:    MessageContentFormat,
		PlainText: normalizeString(fallbackPlainText),
		Blocks:    make([]Block, 0),
	}
	if len(raw) == 0 {
		return content, nil
	}
	var decoded Content
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return Content{}, errors.New("message content is not valid JSON")
	}
	if decoded.Format != "" {
		content.Format = decoded.Format
	}
	if decoded.Blocks != nil {
		content.Blocks = make([]Block, 0, len(decoded.Blocks))
		for _, block := range decoded.Blocks {
			normalized, ok := projectBlock(block, shares)
			if !ok {
				continue
			}
			content.Blocks = append(content.Blocks, normalized)
		}
	}
	content.PlainText = ProjectPlainText(content.Blocks)
	if content.PlainText == "" {
		content.PlainText = normalizeString(fallbackPlainText)
	}
	return content, nil
}

func projectBlock(block Block, shares map[string]EmoteCollectionShare) (Block, bool) {
	switch block.Type {
	case "text":
		return Block{Type: "text", Text: block.Text}, true
	case "mention":
		return Block{Type: "mention", UserID: block.UserID, Label: block.Label}, true
	case "link":
		projected := Block{Type: "link", URL: block.URL}
		if normalizeString(block.Label) != "" {
			projected.Label = block.Label
		}
		return projected, true
	case "emoji":
		return Block{Type: "emoji", Shortcode: block.Shortcode}, true
	case "attachment":
		return Block{Type: "attachment", AttachmentID: block.AttachmentID}, true
	case "emote_collection":
		projected := Block{Type: "emote_collection", ShareID: block.ShareID}
		shareID := normalizeString(block.ShareID)
		if share, ok := shares[shareID]; ok {
			copyShare := cloneEmoteCollectionShare(share)
			projected.Share = &copyShare
		}
		return projected, true
	case "topic_reference":
		return Block{Type: "topic_reference", TopicID: block.TopicID, Title: block.Title}, true
	case "card":
		return Block{
			Type: "card", CardID: block.CardID, CardType: block.CardType,
			SchemaVersion: block.SchemaVersion, FallbackText: block.FallbackText,
		}, true
	default:
		return Block{}, false
	}
}

func cloneEmoteCollectionShare(value EmoteCollectionShare) EmoteCollectionShare {
	result := value
	result.SharedBy = value.SharedBy
	result.OriginalCreator = value.OriginalCreator
	result.Covers = append([]EmoteCollectionShareCover(nil), value.Covers...)
	for index := range result.Covers {
		if animated := result.Covers[index].Animated; animated != nil {
			copyAnimated := *animated
			result.Covers[index].Animated = &copyAnimated
		}
	}
	if result.Covers == nil {
		result.Covers = make([]EmoteCollectionShareCover, 0)
	}
	return result
}

func projectAttachment(record AttachmentRecord, viewer *auth.Actor) Attachment {
	uploaderName := record.UploaderName
	if uploaderName == "" && viewer != nil {
		uploaderName = viewer.DisplayName
	}
	canRemove := false
	if viewer != nil && record.Status == "available" {
		canRemove = record.UploaderID == viewer.ID || viewer.Role == "owner" || viewer.Role == "admin"
	}
	return Attachment{
		ID:             record.ID,
		FileName:       record.FileName,
		MIMEType:       record.MIMEType,
		ByteSize:       record.ByteSize,
		Status:         record.Status,
		Visibility:     record.Visibility,
		UploaderID:     record.UploaderID,
		UploaderName:   uploaderName,
		Uploader:       PublicUploader{ID: record.UploaderID, DisplayName: uploaderName},
		ConversationID: cloneMessageStringPointer(record.ConversationID),
		CreatedAt:      formatTimestamp(record.CreatedAt),
		CompletedAt:    formatNullableTimestamp(record.CompletedAt),
		AvailableAt:    formatNullableTimestamp(record.CompletedAt),
		Capabilities: AttachmentCapabilities{
			CanDownload: record.Status == "available",
			CanRemove:   canRemove,
		},
	}
}

func cloneMessageStringPointer(value *string) *string {
	if value == nil {
		return nil
	}
	copyValue := *value
	return &copyValue
}

func sanitizeMessageAvatar(value string) string {
	value = strings.TrimSpace(value)
	if strings.HasPrefix(value, "/assets/") && !strings.Contains(value, "..") {
		return value
	}
	if strings.HasPrefix(value, "/api/workspace/avatars/") && !strings.Contains(value, "..") {
		return value
	}
	if strings.HasPrefix(value, "https://avatars.githubusercontent.com/") {
		return value
	}
	return ""
}

func cloneReactionGroups(groups []ReactionGroup) []ReactionGroup {
	result := make([]ReactionGroup, 0, len(groups))
	for _, group := range groups {
		copyGroup := group
		copyGroup.Users = append([]ReactionUser(nil), group.Users...)
		if copyGroup.Users == nil {
			copyGroup.Users = make([]ReactionUser, 0)
		}
		result = append(result, copyGroup)
	}
	return result
}

func stringPointer(value *string) *string {
	if value == nil {
		return nil
	}
	copyValue := *value
	return &copyValue
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if normalized := normalizeString(value); normalized != "" {
			return normalized
		}
	}
	return ""
}

func firstNonEmptyPtr(value *string, fallback string) string {
	if value != nil {
		if normalized := normalizeString(*value); normalized != "" {
			return normalized
		}
	}
	return fallback
}

// ProjectPlainText derives the public summary from already projected blocks.
// HTTP and event projections share this function so previews cannot drift.
func ProjectPlainText(blocks []Block) string {
	return nodeSummaryTrim(buildPlainText(blocks))
}

func buildPlainText(blocks []Block) string {
	parts := make([]string, 0, len(blocks))
	for _, block := range blocks {
		var part string
		switch block.Type {
		case "text":
			part = nodeMarkdownSummary(block.Text)
		case "mention":
			part = "@" + block.Label
		case "link":
			part = block.Label
			if part == "" {
				part = block.URL
			}
		case "emoji":
			if strings.HasPrefix(block.Shortcode, "custom:") {
				part = "[表情]"
			} else {
				part = ":" + block.Shortcode + ":"
			}
		case "attachment":
			part = "[文件]"
		case "emote_collection":
			part = "[表情合集]"
		case "topic_reference":
			part = "#" + block.Title
		case "card":
			part = block.FallbackText
		}
		parts = append(parts, part)
	}
	return strings.Join(parts, "")
}

func normalizeSpaceID(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return DefaultSpaceID
	}
	return value
}

func normalizeLimit(value int) int {
	if value <= 0 {
		return DefaultListLimit
	}
	if value > MaxListLimit {
		return MaxListLimit
	}
	return value
}

func normalizeString(value string) string {
	return strings.TrimSpace(value)
}

func normalizeTextBlock(value string) string {
	return strings.Map(func(character rune) rune {
		switch {
		case character <= 0x08, character == 0x0b, character == 0x0c,
			character >= 0x0e && character <= 0x1f, character == 0x7f:
			return -1
		default:
			return character
		}
	}, value)
}

func messageTextLength(value string) (int, int) {
	return utf8.RuneCountInString(value), len([]byte(value))
}

func formatTimestamp(value time.Time) string {
	if value.IsZero() {
		return ""
	}
	return value.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
}

func formatNullableTimestamp(value *time.Time) *string {
	if value == nil || value.IsZero() {
		return nil
	}
	formatted := formatTimestamp(*value)
	return &formatted
}

func displayName(member MentionMember) string {
	if value := normalizeString(member.Nickname); value != "" {
		return value
	}
	if value := normalizeString(member.GitHubLogin); value != "" {
		return value
	}
	if value := normalizeString(member.DisplayName); value != "" {
		return value
	}
	return member.ID
}

func allowedLink(value string) bool {
	parsed, err := url.Parse(value)
	return err == nil && parsed.Host != "" && (strings.EqualFold(parsed.Scheme, "http") || strings.EqualFold(parsed.Scheme, "https"))
}

func validReactionKey(value string) bool {
	return reactionKeyPattern.MatchString(strings.TrimSpace(value))
}

func validEmojiShortcode(value string) bool {
	return emojiShortcodePattern.MatchString(value)
}

func canonicalContent(value Content) ([]byte, error) {
	return json.Marshal(value)
}
