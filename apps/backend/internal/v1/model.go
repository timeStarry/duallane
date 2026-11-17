package v1

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	sdkgate "github.com/timestarry/duallane/apps/backend/internal/workspace/sdkgate"
)

var (
	ErrForbidden         = errors.New("v1.forbidden")
	ErrNotFound          = errors.New("v1.not_found")
	ErrInvalidInput      = errors.New("v1.invalid_input")
	ErrRateLimited       = errors.New("v1.rate_limited")
	ErrProactiveDeny     = errors.New("v1.proactive_disabled")
	ErrEmailAlreadyBound = errors.New("v1.email_already_bound")
	ErrEmailNotBound     = errors.New("v1.email_not_bound")
	ErrChallengeInvalid  = errors.New("v1.challenge_invalid")
)

type V1BootstrapMember struct {
	ID string `json:"id"`
	// BotID is emitted only for a visible custom Agent Bot. ID remains the
	// public user identity, including for bots.
	BotID       string `json:"botId,omitempty"`
	DisplayName string `json:"displayName"`
	Nickname    string `json:"nickname,omitempty"`
	Remark      string `json:"remark,omitempty"`
	Description string `json:"description,omitempty"`
	GitHubLogin string `json:"githubLogin,omitempty"`
	Kind        string `json:"kind"`
	Role        string `json:"role"`
	AvatarURL   string `json:"avatarUrl,omitempty"`
	AvatarColor string `json:"avatarColor,omitempty"`
	BotOnline   *bool  `json:"botOnline,omitempty"`
}

type V1BootstrapAuth struct {
	Enabled     bool              `json:"enabled"`
	CurrentUser V1BootstrapMember `json:"currentUser"`
	BoundEmail  string            `json:"boundEmail,omitempty"`
}

type V1BootstrapPolicy struct {
	DailyQuotaBytes int64 `json:"dailyQuotaBytes"`
	UsedTodayBytes  int64 `json:"usedTodayBytes"`
}

type V1BootstrapConversation struct {
	ID                    string   `json:"id"`
	Type                  string   `json:"type"`
	Title                 string   `json:"title"`
	DisplayTitle          string   `json:"displayTitle"`
	AvatarEmoji           *string  `json:"avatarEmoji,omitempty"`
	UnreadCount           int      `json:"unreadCount"`
	NotificationLevel     string   `json:"notificationLevel,omitempty"`
	PinnedMessageIDs      []string `json:"pinnedMessageIds"`
	MemberIDs             []string `json:"memberIds"`
	LastMessagePlainText  string   `json:"lastMessagePlainText,omitempty"`
	LastMessageSenderID   string   `json:"lastMessageSenderId,omitempty"`
	LastMessageSenderName string   `json:"lastMessageSenderName,omitempty"`
	LastMessageAt         *string  `json:"lastMessageAt,omitempty"`
	PeerLastReadAt        *string  `json:"peerLastReadAt,omitempty"`
}

type SystemAnnouncement struct {
	ID          string `json:"id"`
	Enabled     bool   `json:"enabled"`
	DisplayMode string `json:"displayMode"`
	Badge       string `json:"badge,omitempty"`
	Title       string `json:"title"`
	Content     string `json:"content"`
	CTALabel    string `json:"ctaLabel,omitempty"`
	CTAURL      string `json:"ctaUrl,omitempty"`
	UpdatedAt   string `json:"updatedAt,omitempty"`
	ShouldShow  bool   `json:"shouldShow"`
}

type SystemAnnouncementUpdateInput struct {
	Enabled     bool   `json:"enabled"`
	DisplayMode string `json:"displayMode"`
	Badge       string `json:"badge"`
	Title       string `json:"title"`
	Content     string `json:"content"`
	CTALabel    string `json:"ctaLabel"`
	CTAURL      string `json:"ctaUrl"`
	ResetAck    bool   `json:"resetAck"`
}

type MobileOTABundle struct {
	Enabled              bool   `json:"enabled"`
	Version              string `json:"version"`
	BundleID             string `json:"bundleId"`
	MinNativeVersionCode int    `json:"minNativeVersionCode"`
	ByteSize             int64  `json:"byteSize"`
	SHA256               string `json:"sha256"`
	DownloadURL          string `json:"downloadUrl"`
	PublishedAt          string `json:"publishedAt,omitempty"`
}

type MobileClientRelease struct {
	Enabled     bool             `json:"enabled"`
	Version     string           `json:"version"`
	VersionCode int              `json:"versionCode"`
	TagName     string           `json:"tagName"`
	Title       string           `json:"title"`
	Notes       string           `json:"notes"`
	FileName    string           `json:"fileName"`
	ByteSize    int64            `json:"byteSize"`
	SHA256      string           `json:"sha256"`
	DownloadURL string           `json:"downloadUrl"`
	PublishedAt string           `json:"publishedAt,omitempty"`
	UpdatedBy   string           `json:"updatedBy,omitempty"`
	OTA         *MobileOTABundle `json:"ota,omitempty"`
}

type MobileClientReleaseMetadataInput struct {
	Enabled              bool   `json:"enabled"`
	Version              string `json:"version"`
	VersionCode          int    `json:"versionCode"`
	Title                string `json:"title"`
	Notes                string `json:"notes"`
	MinNativeVersionCode int    `json:"minNativeVersionCode,omitempty"`
	OTAEnabled           *bool  `json:"otaEnabled,omitempty"`
}

type EmailChallengeSummary struct {
	ChallengeID        string `json:"challengeId"`
	MaskedEmail        string `json:"maskedEmail"`
	ExpiresAt          string `json:"expiresAt"`
	ResendAfterSeconds int    `json:"resendAfterSeconds"`
}

type BoundEmailStatus struct {
	BoundEmail  string `json:"boundEmail"`
	MaskedEmail string `json:"maskedEmail"`
}

type EmailChallengeStoreRecord struct {
	ID           string
	UserID       string
	PendingEmail string
	CodeHash     string
	Attempts     int
	CreatedAt    time.Time
	ExpiresAt    time.Time
	ConsumedAt   *time.Time
}

type V1BootstrapResponse struct {
	Auth          V1BootstrapAuth           `json:"auth"`
	Policy        V1BootstrapPolicy         `json:"policy"`
	Preferences   map[string]any            `json:"preferences"`
	Announcement  *SystemAnnouncement       `json:"announcement,omitempty"`
	Members       []V1BootstrapMember       `json:"members"`
	Conversations []V1BootstrapConversation `json:"conversations"`
	EventCursor   int64                     `json:"eventCursor"`
}

type SyncEvent struct {
	Seq            int64          `json:"seq"`
	Type           string         `json:"type"`
	ConversationID string         `json:"conversationId,omitempty"`
	Payload        map[string]any `json:"payload"`
	CreatedAt      string         `json:"createdAt"`
}

type SyncDeltaResponse struct {
	CurrentSeq    int64       `json:"currentSeq"`
	HasMore       bool        `json:"hasMore"`
	ResetRequired bool        `json:"resetRequired"`
	Events        []SyncEvent `json:"events"`
}

type SearchMessageHit struct {
	ID             string `json:"id"`
	ConversationID string `json:"conversationId"`
	ThreadRootID   string `json:"threadRootId,omitempty"`
	AuthorID       string `json:"authorId"`
	AuthorName     string `json:"authorName"`
	PlainText      string `json:"plainText"`
	CreatedAt      string `json:"createdAt"`
}

type SearchFileHit struct {
	ID              string `json:"id"`
	FileName        string `json:"fileName"`
	MIMEType        string `json:"mimeType"`
	ByteSize        int64  `json:"byteSize"`
	ConversationID  string `json:"conversationId,omitempty"`
	SourceMessageID string `json:"sourceMessageId,omitempty"`
	Width           *int   `json:"width,omitempty"`
	Height          *int   `json:"height,omitempty"`
	ThumbHash       string `json:"thumbHash,omitempty"`
	CreatedAt       string `json:"createdAt"`
}

type SearchResponse struct {
	Messages []SearchMessageHit `json:"messages"`
	Files    []SearchFileHit    `json:"files"`
}

type ThreadReply struct {
	ID                string `json:"id"`
	ConversationID    string `json:"conversationId"`
	ThreadRootID      string `json:"threadRootId"`
	AlsoSendToChannel bool   `json:"alsoSendToChannel"`
	AuthorID          string `json:"authorId"`
	AuthorName        string `json:"authorName"`
	AuthorAvatarURL   string `json:"authorAvatarUrl,omitempty"`
	PlainText         string `json:"plainText"`
	EditedAt          string `json:"editedAt,omitempty"`
	CreatedAt         string `json:"createdAt"`
}

type ThreadView struct {
	RootMessageID string        `json:"rootMessageId"`
	ThreadTitle   string        `json:"threadTitle,omitempty"`
	ReplyCount    int           `json:"replyCount"`
	Replies       []ThreadReply `json:"replies"`
}

type ConversationThreadItem struct {
	RootMessageID  string `json:"rootMessageId"`
	ConversationID string `json:"conversationId"`
	ThreadTitle    string `json:"threadTitle,omitempty"`
	RootAuthorID   string `json:"rootAuthorId"`
	RootAuthorName string `json:"rootAuthorName"`
	RootPlainText  string `json:"rootPlainText"`
	RootCreatedAt  string `json:"rootCreatedAt"`
	ReplyCount     int    `json:"replyCount"`
	LastRepliedAt  string `json:"lastRepliedAt"`
	LastAuthorName string `json:"lastAuthorName"`
	LastPlainText  string `json:"lastPlainText"`
}

type UserDevice struct {
	ID           string `json:"id"`
	Platform     string `json:"platform"`
	DeviceName   string `json:"deviceName"`
	AppVersion   string `json:"appVersion"`
	LastActiveAt string `json:"lastActiveAt"`
	Current      bool   `json:"current"`
}

type QRLoginSession struct {
	ID         string `json:"id"`
	Challenge  string `json:"challenge"`
	Status     string `json:"status"`
	Platform   string `json:"platform,omitempty"`
	DeviceName string `json:"deviceName,omitempty"`
	ExpiresAt  string `json:"expiresAt"`
}

type BotCommand struct {
	Command     string `json:"command"`
	Description string `json:"description"`
	Scope       string `json:"scope"`
	BotID       string `json:"botId,omitempty"`
	BotName     string `json:"botName,omitempty"`
}

type BotProfileUpdateInput struct {
	Name           *string `json:"name,omitempty"`
	NameSet        bool    `json:"-"`
	Description    *string `json:"description,omitempty"`
	DescriptionSet bool    `json:"-"`
	Color          *string `json:"color,omitempty"`
	ColorSet       bool    `json:"-"`
}

type BotProfileResult struct {
	BotID       string `json:"botId"`
	BotUserID   string `json:"botUserId"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	AvatarURL   string `json:"avatarUrl,omitempty"`
	AvatarColor string `json:"avatarColor,omitempty"`
}

func IsValidBotColor(color string) bool {
	switch color {
	case "", "azure", "indigo", "violet", "emerald", "cyan", "amber", "rose", "slate":
		return true
	default:
		return false
	}
}

type BotAvatarPayload struct {
	MIMEType string
	Data     []byte
}

const LatestAgentSDKVersion = sdkgate.LatestSDKVersion

type BotWebhookConfig struct {
	BotID      string `json:"botId"`
	URL        string `json:"url"`
	Enabled    bool   `json:"enabled"`
	LastStatus *int   `json:"lastStatus,omitempty"`
	LastError  string `json:"lastError,omitempty"`
}

type BotConversationSummary struct {
	ID                string `json:"id"`
	Type              string `json:"type"`
	Title             string `json:"title"`
	IsOwnerDirect     bool   `json:"isOwnerDirect,omitempty"`
	AllowSend         bool   `json:"allowSend"`
	AllowTrigger      bool   `json:"allowTrigger"`
	AllowContext      bool   `json:"allowContext"`
	MaxMessages       int    `json:"maxMessages"`
	TriggerMode       string `json:"triggerMode,omitempty"`
	GroupPolicyStatus string `json:"groupPolicyStatus,omitempty"`
	BlockReason       string `json:"blockReason,omitempty"`
	UpdatedAt         string `json:"updatedAt"`
}

type BotDeliveryDiagnostic struct {
	ID                string `json:"id"`
	Sequence          int64  `json:"sequence"`
	EventType         string `json:"eventType"`
	ConversationID    string `json:"conversationId,omitempty"`
	ConversationTitle string `json:"conversationTitle,omitempty"`
	Status            string `json:"status"`
	Attempts          int    `json:"attempts"`
	CreatedAt         string `json:"createdAt"`
	AckedAt           string `json:"ackedAt,omitempty"`
}

type BotConsoleOverview struct {
	BotID            string                   `json:"botId"`
	BotUserID        string                   `json:"botUserId"`
	LatestSDKVersion string                   `json:"latestSdkVersion"`
	Conversations    []BotConversationSummary `json:"conversations"`
	RecentDeliveries []BotDeliveryDiagnostic  `json:"recentDeliveries"`
	Webhook          *BotWebhookConfig        `json:"webhook,omitempty"`
}

type CardKitBlock struct {
	Type     string           `json:"type"`
	Title    string           `json:"title,omitempty"`
	Subtitle string           `json:"subtitle,omitempty"`
	Badge    string           `json:"badge,omitempty"`
	Tone     string           `json:"tone,omitempty"`
	Content  string           `json:"content,omitempty"`
	Items    []map[string]any `json:"items,omitempty"`
	PollID   string           `json:"pollId,omitempty"`
	Options  []map[string]any `json:"options,omitempty"`
	Elements []map[string]any `json:"elements,omitempty"`
}

type CardKitDocument struct {
	Version      int            `json:"version"`
	CardID       string         `json:"cardId"`
	CardType     string         `json:"cardType"`
	Status       string         `json:"status"`
	Revision     int            `json:"revision"`
	FallbackText string         `json:"fallbackText"`
	Blocks       []CardKitBlock `json:"blocks"`
}

func ValidateCardKitDocument(doc CardKitDocument) error {
	if doc.Version != 1 {
		return fmt.Errorf("%w: card version must be 1", ErrInvalidInput)
	}
	if strings.TrimSpace(doc.FallbackText) == "" {
		return fmt.Errorf("%w: fallbackText is required", ErrInvalidInput)
	}
	if len(doc.Blocks) == 0 || len(doc.Blocks) > 32 {
		return fmt.Errorf("%w: blocks must contain 1..32 items", ErrInvalidInput)
	}
	for i, block := range doc.Blocks {
		switch block.Type {
		case "header":
			if strings.TrimSpace(block.Title) == "" {
				return fmt.Errorf("%w: block[%d] header requires title", ErrInvalidInput, i)
			}
		case "markdown":
			if strings.TrimSpace(block.Content) == "" {
				return fmt.Errorf("%w: block[%d] markdown requires content", ErrInvalidInput, i)
			}
		case "fields":
			if len(block.Items) == 0 {
				return fmt.Errorf("%w: block[%d] fields requires items", ErrInvalidInput, i)
			}
		case "poll":
			if strings.TrimSpace(block.PollID) == "" || len(block.Options) < 2 {
				return fmt.Errorf("%w: block[%d] poll requires pollId and at least 2 options", ErrInvalidInput, i)
			}
		case "actions":
			if len(block.Elements) == 0 || len(block.Elements) > 8 {
				return fmt.Errorf("%w: block[%d] actions requires 1..8 elements", ErrInvalidInput, i)
			}
			for j, el := range block.Elements {
				actionID, _ := el["actionId"].(string)
				if strings.TrimSpace(actionID) == "" {
					return fmt.Errorf("%w: block[%d].elements[%d] requires non-empty actionId", ErrInvalidInput, i, j)
				}
			}
		case "divider":
			// valid separator
		default:
			return fmt.Errorf("%w: unsupported block type %q", ErrInvalidInput, block.Type)
		}
	}
	return nil
}

func SignWebhookDelivery(secret string, timestamp time.Time, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(fmt.Sprintf("%d.", timestamp.UTC().Unix())))
	mac.Write(body)
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}

type AdminCounts struct {
	Members       int64 `json:"members"`
	Conversations int64 `json:"conversations"`
	Messages      int64 `json:"messages"`
	Files         int64 `json:"files"`
	UploadedBytes int64 `json:"uploadedBytes"`
}

type AdminSpaceSummary struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Slug      string `json:"slug"`
	CreatedAt string `json:"createdAt"`
}

type AdminSpacePolicy struct {
	DailyQuotaBytes       int64  `json:"dailyQuotaBytes"`
	MessageRetentionCount int    `json:"messageRetentionCount"`
	UpdatedAt             string `json:"updatedAt,omitempty"`
}

type StorageOperatorRunSummary struct {
	ID             string `json:"id"`
	Operation      string `json:"operation"`
	State          string `json:"state"`
	Phase          string `json:"phase"`
	TotalItems     int    `json:"totalItems"`
	ProcessedItems int    `json:"processedItems"`
	LastErrorCode  string `json:"lastErrorCode,omitempty"`
	StartedAt      string `json:"startedAt"`
	CompletedAt    string `json:"completedAt,omitempty"`
}

type AdminStorageSummary struct {
	ActiveAttachments      int64                       `json:"activeAttachments"`
	ActiveBytes            int64                       `json:"activeBytes"`
	PendingUploads         int64                       `json:"pendingUploads"`
	PendingBytes           int64                       `json:"pendingBytes"`
	ReclaimableAttachments int64                       `json:"reclaimableAttachments"`
	ReclaimableBytes       int64                       `json:"reclaimableBytes"`
	CASObjects             int64                       `json:"casObjects"`
	CASBytes               int64                       `json:"casBytes"`
	RecentOperatorRuns     []StorageOperatorRunSummary `json:"recentOperatorRuns"`
}

type AdminOverviewResponse struct {
	Space      AdminSpaceSummary   `json:"space"`
	Totals     AdminCounts         `json:"totals"`
	Today      AdminCounts         `json:"today"`
	Policy     AdminSpacePolicy    `json:"policy"`
	Storage    AdminStorageSummary `json:"storage"`
	ViewerRole string              `json:"viewerRole"`
}

type AdminInviteItem struct {
	ID            string  `json:"id"`
	CodePreview   string  `json:"codePreview"`
	DefaultRole   string  `json:"defaultRole"`
	MaxUses       int     `json:"maxUses"`
	Uses          int     `json:"uses"`
	Status        string  `json:"status"`
	CreatedByName string  `json:"createdByName"`
	ExpiresAt     *string `json:"expiresAt,omitempty"`
	RevokedAt     *string `json:"revokedAt,omitempty"`
	CreatedAt     string  `json:"createdAt"`
}

type AdminInviteListResponse struct {
	Total         int               `json:"total"`
	Active        int               `json:"active"`
	AcceptedUses  int               `json:"acceptedUses"`
	AvailableUses int               `json:"availableUses"`
	Invites       []AdminInviteItem `json:"invites"`
}

type AdminAuditLogItem struct {
	ID               string `json:"id"`
	ActorUserID      string `json:"actorUserId,omitempty"`
	ActorDisplayName string `json:"actorDisplayName"`
	ActorGitHubLogin string `json:"actorGitHubLogin,omitempty"`
	Action           string `json:"action"`
	TargetType       string `json:"targetType"`
	TargetID         string `json:"targetId,omitempty"`
	Result           string `json:"result"`
	Reason           string `json:"reason,omitempty"`
	IPAddress        string `json:"ipAddress,omitempty"`
	RequestID        string `json:"requestId,omitempty"`
	CreatedAt        string `json:"createdAt"`
}

type AdminPolicyUpdateInput struct {
	SpaceName             string `json:"spaceName"`
	DailyQuotaBytes       int64  `json:"dailyQuotaBytes"`
	MessageRetentionCount int    `json:"messageRetentionCount"`
}

type AdminStorageCleanupResult struct {
	ReleasedTransfers  int64 `json:"releasedTransfers"`
	CleanedAttachments int64 `json:"cleanedAttachments"`
	ReclaimedBytes     int64 `json:"reclaimedBytes"`
}

type GroupMemberSummary struct {
	ID          string `json:"id"`
	DisplayName string `json:"displayName"`
	GitHubLogin string `json:"githubLogin,omitempty"`
	Kind        string `json:"kind"`
	Role        string `json:"role"`
	AvatarURL   string `json:"avatarUrl,omitempty"`
}

type GroupConversationSummary struct {
	ID          string               `json:"id"`
	Type        string               `json:"type"`
	Title       string               `json:"title"`
	AvatarEmoji *string              `json:"avatarEmoji"`
	MemberIDs   []string             `json:"memberIds"`
	Members     []GroupMemberSummary `json:"members"`
	CreatedAt   string               `json:"createdAt"`
}

type CreateGroupInput struct {
	Title     string   `json:"title"`
	MemberIDs []string `json:"memberIds"`
	Avatar    *string  `json:"avatar,omitempty"`
}

type UpdateGroupInput struct {
	Title     *string `json:"title,omitempty"`
	TitleSet  bool    `json:"-"`
	Avatar    *string `json:"avatar,omitempty"`
	AvatarSet bool    `json:"-"`
}

const (
	workspaceFilePreviewPrefix = "/api/workspace/files/"
	workspaceFilePreviewSuffix = "/preview"
)

// NormalizeGroupAvatarValue validates either an empty reset, a workspace file preview URL,
// or a short emoji string. External URLs or HTML/path traversal payloads are rejected.
func NormalizeGroupAvatarValue(raw string) (kind string, normalized string, attachmentID string, err error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "empty", "", "", nil
	}
	if strings.HasPrefix(trimmed, "/") || strings.Contains(trimmed, "://") {
		if !strings.HasPrefix(trimmed, workspaceFilePreviewPrefix) || !strings.HasSuffix(trimmed, workspaceFilePreviewSuffix) {
			return "", "", "", fmt.Errorf("%w: group avatar image must use workspace file preview", ErrInvalidInput)
		}
		id := strings.TrimSuffix(strings.TrimPrefix(trimmed, workspaceFilePreviewPrefix), workspaceFilePreviewSuffix)
		if id == "" || len(id) > 128 {
			return "", "", "", fmt.Errorf("%w: invalid group avatar attachment id", ErrInvalidInput)
		}
		for _, r := range id {
			if !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_' || r == '-') {
				return "", "", "", fmt.Errorf("%w: invalid group avatar attachment id", ErrInvalidInput)
			}
		}
		return "file", workspaceFilePreviewPrefix + id + workspaceFilePreviewSuffix, id, nil
	}
	if !utf8.ValidString(trimmed) {
		return "", "", "", fmt.Errorf("%w: invalid group avatar encoding", ErrInvalidInput)
	}
	runeCount := utf8.RuneCountInString(trimmed)
	if runeCount < 1 || runeCount > 12 {
		return "", "", "", fmt.Errorf("%w: group emoji avatar length out of range", ErrInvalidInput)
	}
	hasSymbol := false
	for _, r := range trimmed {
		if unicode.IsSpace(r) || unicode.IsControl(r) || strings.ContainsRune(`/\<>:"'`, r) {
			return "", "", "", fmt.Errorf("%w: invalid characters in group avatar", ErrInvalidInput)
		}
		if r > 0x7f {
			hasSymbol = true
		}
	}
	if !hasSymbol {
		return "", "", "", fmt.Errorf("%w: group avatar must be an emoji or uploaded image", ErrInvalidInput)
	}
	return "emoji", trimmed, "", nil
}
