package bootstrap

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/conversations"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/files"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/members"
)

type MemberService interface {
	List(context.Context, members.ListInput) ([]members.Member, error)
}

type ConversationService interface {
	ListConversations(context.Context, string, auth.RequestMeta) ([]conversations.Conversation, error)
}

type FileService interface {
	ReleaseStaleUploadReservations(context.Context) (int, error)
	GetQuota(context.Context, string) (files.QuotaSnapshot, error)
	ListFiles(context.Context, files.ListFilesInput) ([]files.Attachment, error)
}

type EventService interface {
	CurrentSeq(context.Context) (int64, error)
}

type ServiceOptions struct {
	Repository    Repository
	Members       MemberService
	Conversations ConversationService
	Files         FileService
	Events        EventService
	SpaceID       string
	AppVersion    string
	Now           func() time.Time
}

type Service struct {
	repository    Repository
	members       MemberService
	conversations ConversationService
	files         FileService
	events        EventService
	spaceID       string
	appVersion    string
	now           func() time.Time
}

func NewService(options ServiceOptions) *Service {
	spaceID := strings.TrimSpace(options.SpaceID)
	if spaceID == "" {
		spaceID = DefaultSpaceID
	}
	now := options.Now
	if now == nil {
		now = time.Now
	}
	return &Service{
		repository: options.Repository, members: options.Members, conversations: options.Conversations,
		files: options.Files, events: options.Events, spaceID: spaceID,
		appVersion: strings.TrimSpace(options.AppVersion), now: now,
	}
}

func (service *Service) Get(ctx context.Context, actorID string, meta auth.RequestMeta) (Bootstrap, error) {
	if service == nil || service.repository == nil || service.members == nil || service.files == nil || service.events == nil {
		return Bootstrap{}, errors.New("workspace bootstrap dependencies are required")
	}
	actorID = strings.TrimSpace(actorID)
	if actorID == "" {
		return Bootstrap{}, auth.NewError(auth.CodeRequired, auth.MessageRequired, 401)
	}
	memberList, err := service.members.List(ctx, members.ListInput{ActorID: actorID, Meta: meta})
	if err != nil {
		return Bootstrap{}, err
	}
	currentUser, ok := findMember(memberList, actorID)
	if !ok || currentUser.Kind != "human" {
		return Bootstrap{}, auth.NewError(auth.CodeRequired, auth.MessageRequired, 401)
	}
	permissions := permissionsForRole(currentUser.Role)
	if _, err := service.files.ReleaseStaleUploadReservations(ctx); err != nil {
		return Bootstrap{}, err
	}
	quota, err := service.files.GetQuota(ctx, actorID)
	if err != nil {
		return Bootstrap{}, err
	}
	snapshot, err := service.repository.Load(ctx, service.spaceID, currentUser.Role, service.nowUTC())
	if err != nil {
		return Bootstrap{}, err
	}
	cursor, err := service.events.CurrentSeq(ctx)
	if err != nil {
		return Bootstrap{}, err
	}
	conversationList := make([]conversations.Conversation, 0)
	if permissions.CanReadConversations {
		if service.conversations == nil {
			return Bootstrap{}, errors.New("workspace conversation service is required")
		}
		conversationList, err = service.conversations.ListConversations(ctx, actorID, meta)
		if err != nil {
			return Bootstrap{}, err
		}
	}
	fileList := make([]files.Attachment, 0)
	if permissions.CanDownload {
		fileList, err = service.files.ListFiles(ctx, files.ListFilesInput{ActorID: actorID, Meta: meta})
		if err != nil {
			return Bootstrap{}, err
		}
	}
	return Bootstrap{
		AppVersion: service.appVersion,
		Auth:       Auth{Mode: "development", InviteOnly: true, CurrentUser: currentUser},
		Space: Space{ID: snapshot.Space.ID, Name: snapshot.Space.Name, Slug: snapshot.Space.Slug,
			CreatedBy: snapshot.Space.CreatedBy, CreatedAt: formatTime(snapshot.Space.CreatedAt)},
		Policy: Policy{DailyQuotaBytes: quota.DailyQuotaBytes, UsedTodayBytes: quota.UsedToday,
			RemainingQuotaBytes: quota.RemainingBytes, MessageRetentionCount: MessageRetentionCount,
			MemberVisibilityBasis: members.MemberVisibilityBasis},
		Permissions: permissions, Members: memberList, Conversations: conversationList, Files: fileList,
		Invites: projectInvites(snapshot.Invites, memberList), InviteSummary: snapshot.InviteSummary, EventCursor: cursor,
	}, nil
}

func (service *Service) nowUTC() time.Time {
	now := service.now()
	if now.IsZero() {
		now = time.Unix(0, 0)
	}
	return now.UTC().Truncate(time.Millisecond)
}

func findMember(items []members.Member, id string) (members.Member, bool) {
	for _, item := range items {
		if item.ID == id {
			return item, true
		}
	}
	return members.Member{}, false
}

func permissionsForRole(role string) Permissions {
	permissions := Permissions{CanViewOperationRecords: false}
	switch strings.TrimSpace(role) {
	case members.RoleOwner:
		permissions.CanCreateMemberInvite = true
		permissions.CanCreatePrivilegedInvite = true
		permissions.CanManageMemberVisibility = true
		permissions.CanManageEmailSettings = true
		permissions.CanReadConversations = true
		permissions.CanCreateGroup = true
		permissions.CanCreateDirect = true
		permissions.CanUpload = true
		permissions.CanDownload = true
	case members.RoleAdmin:
		permissions.CanCreateMemberInvite = true
		permissions.CanReadConversations = true
		permissions.CanCreateGroup = true
		permissions.CanCreateDirect = true
		permissions.CanUpload = true
		permissions.CanDownload = true
	case members.RoleMember:
		permissions.CanReadConversations = true
		permissions.CanCreateDirect = true
		permissions.CanUpload = true
		permissions.CanDownload = true
	}
	return permissions
}

func projectInvites(records []InviteRecord, visibleMembers []members.Member) []Invite {
	memberByID := make(map[string]members.Member, len(visibleMembers))
	for _, member := range visibleMembers {
		memberByID[member.ID] = member
	}
	result := make([]Invite, 0, len(records))
	for _, record := range records {
		accepted := make([]AcceptedMember, 0, len(record.Acceptances))
		for _, acceptance := range record.Acceptances {
			member, visible := memberByID[acceptance.UserID]
			if visible {
				accepted = append(accepted, AcceptedMember{Member: member, AcceptedAt: formatTime(acceptance.AcceptedAt)})
			}
		}
		result = append(result, Invite{
			ID: record.ID, CodePreview: record.CodePreview, DefaultRole: record.DefaultRole,
			MaxUses: record.MaxUses, Uses: record.Uses, ExpiresAt: formatTimePointer(record.ExpiresAt),
			RevokedAt: formatTimePointer(record.RevokedAt), CreatedAt: formatTime(record.CreatedAt),
			AcceptedMemberCount: len(record.Acceptances), AcceptedMembers: accepted,
		})
	}
	return result
}

func formatTime(value time.Time) string {
	if value.IsZero() {
		return ""
	}
	return value.UTC().Format(time.RFC3339Nano)
}

func formatTimePointer(value *time.Time) *string {
	if value == nil {
		return nil
	}
	formatted := formatTime(*value)
	return &formatted
}
