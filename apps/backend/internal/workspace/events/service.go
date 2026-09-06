package events

import (
	"context"
	"errors"
	"math"
	"strconv"
	"strings"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

type ServiceOptions struct {
	Repository  Repository
	SpaceID     string
	ReplayLimit int
	BatchSize   int
}

// Service owns replay ordering, cursor semantics, and the transport-safe
// projection. Resource authorization remains a repository query so the same
// checks are repeated against current PostgreSQL state for every replay.
type Service struct {
	repo        Repository
	spaceID     string
	replayLimit int
	batchSize   int
}

func NewService(options ServiceOptions) *Service {
	spaceID := strings.TrimSpace(options.SpaceID)
	if spaceID == "" {
		spaceID = DefaultSpaceID
	}
	limit := options.ReplayLimit
	if limit <= 0 {
		limit = DefaultReplayLimit
	}
	if limit > MaxReplayLimit {
		limit = MaxReplayLimit
	}
	batch := options.BatchSize
	if batch <= 0 {
		batch = DefaultBatchSize
	}
	if batch > MaxBatchSize {
		batch = MaxBatchSize
	}
	return &Service{repo: options.Repository, spaceID: spaceID, replayLimit: limit, batchSize: batch}
}

func NewServiceForRepository(repo Repository) *Service {
	return NewService(ServiceOptions{Repository: repo})
}

func (s *Service) Repository() Repository {
	if s == nil {
		return nil
	}
	return s.repo
}

func (s *Service) space() string {
	if s == nil || strings.TrimSpace(s.spaceID) == "" {
		return DefaultSpaceID
	}
	return s.spaceID
}

// CurrentSeq returns the durable cursor without creating an in-process
// subscription. LISTEN/NOTIFY callers must use this value for catch-up.
func (s *Service) CurrentSeq(ctx context.Context) (int64, error) {
	if s == nil || s.repo == nil {
		return 0, internalError("read workspace event cursor", errors.New("repository is required"))
	}
	seq, err := s.repo.CurrentSeq(ctx, s.space())
	if err != nil {
		return 0, normalizeError(err)
	}
	if seq < 0 {
		return 0, sequenceInvalidError()
	}
	return seq, nil
}

// Replay re-authenticates actorID and returns one bounded visible batch. The
// query page is bounded, but invisible rows are scanned in additional bounded
// pages so the visible limit is applied after authorization filtering.
func (s *Service) Replay(ctx context.Context, input ReplayInput) (ReplayResult, error) {
	if s == nil || s.repo == nil {
		return ReplayResult{}, internalError("replay workspace events", errors.New("repository is required"))
	}
	actorID := strings.TrimSpace(input.ActorID)
	if actorID == "" {
		return ReplayResult{}, authRequiredError()
	}
	actor, err := s.lookupActor(ctx, actorID)
	if err != nil {
		return ReplayResult{}, err
	}

	lastSeq := input.LastSeq
	if lastSeq < 0 {
		lastSeq = 0
	}
	currentSeq, err := s.repo.CurrentSeq(ctx, s.space())
	if err != nil {
		return ReplayResult{}, normalizeError(err)
	}
	if currentSeq < 0 {
		return ReplayResult{}, sequenceInvalidError()
	}
	result := ReplayResult{
		Events:     make([]Event, 0),
		CurrentSeq: currentSeq,
		ReplayFrom: lastSeq + 1,
	}
	if lastSeq > currentSeq {
		result.SyncRequired = true
		result.Reason = SyncReasonCursorAhead
		return result, nil
	}

	earliestSeq, err := s.repo.EarliestSeq(ctx, s.space())
	if err != nil {
		return ReplayResult{}, normalizeError(err)
	}
	if earliestSeq < 0 {
		return ReplayResult{}, sequenceInvalidError()
	}
	if earliestSeq > 0 && lastSeq < earliestSeq-1 {
		result.SyncRequired = true
		result.Reason = SyncReasonReplayWindow
		return result, nil
	}

	limit := s.replayLimit
	if input.Limit > 0 && input.Limit < limit {
		limit = input.Limit
	}
	if limit > MaxReplayLimit {
		limit = MaxReplayLimit
	}
	batchSize := s.batchSize
	if batchSize <= 0 || batchSize > MaxBatchSize {
		batchSize = DefaultBatchSize
	}

	cursor := lastSeq
	for {
		rows, err := s.repo.ListEventsAfter(ctx, s.space(), cursor, batchSize)
		if err != nil {
			return ReplayResult{}, normalizeError(err)
		}
		if len(rows) == 0 {
			break
		}
		for _, row := range rows {
			if strings.TrimSpace(row.SpaceID) != s.space() {
				return ReplayResult{}, internalError("replay workspace events", errors.New("event belongs to another space"))
			}
			if row.Seq <= cursor {
				return ReplayResult{}, internalError("replay workspace events", errors.New("event sequence is not strictly increasing"))
			}
			cursor = row.Seq
			payload := ParsePayloadObject(row.PayloadJSON)
			visible, err := s.repo.EventVisible(ctx, actor, row, payload)
			if err != nil {
				return ReplayResult{}, normalizeError(err)
			}
			if !visible {
				continue
			}
			payload, err = s.projectPayload(ctx, actor, row, payload)
			if err != nil {
				return ReplayResult{}, normalizeError(err)
			}
			if len(result.Events) >= limit {
				result.HasMore = true
				break
			}
			result.Events = append(result.Events, projectEvent(row, payload, actor))
		}
		if result.HasMore {
			break
		}
		if len(rows) < batchSize {
			break
		}
	}
	result.ReplayCount = len(result.Events)
	if cursor > result.CurrentSeq {
		result.CurrentSeq = cursor
	}
	return result, nil
}

// ListAfter is an alias for callers that want the event-domain name while
// retaining the ready/sync metadata required by the WebSocket contract.
func (s *Service) ListAfter(ctx context.Context, actorID string, lastSeq int64) (ReplayResult, error) {
	return s.Replay(ctx, ReplayInput{ActorID: actorID, LastSeq: lastSeq})
}

// ListEventsAfter is the explicit storage-shaped alias used by transport
// adapters migrating from the legacy listWorkspaceEvents helper.
func (s *Service) ListEventsAfter(ctx context.Context, actorID string, lastSeq int64) (ReplayResult, error) {
	return s.ListAfter(ctx, actorID, lastSeq)
}

// GetForActor resolves one durable event for a wakeup path and repeats the
// same current visibility check used by replay. A notification is only a hint;
// callers must still fetch this row from the database.
func (s *Service) GetForActor(ctx context.Context, actorID, eventID string) (*Event, error) {
	if s == nil || s.repo == nil {
		return nil, internalError("read workspace event", errors.New("repository is required"))
	}
	actorID = strings.TrimSpace(actorID)
	if actorID == "" {
		return nil, authRequiredError()
	}
	actor, err := s.lookupActor(ctx, actorID)
	if err != nil {
		return nil, err
	}
	lookup, ok := s.repo.(EventLookup)
	if !ok {
		return nil, internalError("read workspace event", errors.New("event lookup is not supported"))
	}
	record, err := lookup.GetEvent(ctx, s.space(), strings.TrimSpace(eventID))
	if err != nil {
		return nil, normalizeError(err)
	}
	if record == nil {
		return nil, nil
	}
	if strings.TrimSpace(record.SpaceID) != s.space() {
		return nil, internalError("read workspace event", errors.New("event belongs to another space"))
	}
	payload := ParsePayloadObject(record.PayloadJSON)
	visible, err := s.repo.EventVisible(ctx, actor, *record, payload)
	if err != nil {
		return nil, normalizeError(err)
	}
	if !visible {
		return nil, nil
	}
	payload, err = s.projectPayload(ctx, actor, *record, payload)
	if err != nil {
		return nil, normalizeError(err)
	}
	projected := projectEvent(*record, payload, actor)
	return &projected, nil
}

func (s *Service) GetEventForActor(ctx context.Context, actorID, eventID string) (*Event, error) {
	return s.GetForActor(ctx, actorID, eventID)
}

func (s *Service) projectPayload(ctx context.Context, actor *auth.Actor, event EventRecord, payload map[string]any) (map[string]any, error) {
	projector, ok := s.repo.(PayloadProjector)
	if !ok {
		return payload, nil
	}
	projected, err := projector.ProjectEventPayload(ctx, actor, event, payload)
	if err != nil {
		return nil, err
	}
	if projected == nil {
		return map[string]any{}, nil
	}
	return projected, nil
}

func (s *Service) lookupActor(ctx context.Context, actorID string) (*auth.Actor, error) {
	actor, err := s.repo.LookupActor(ctx, s.space(), actorID)
	if err != nil {
		return nil, normalizeError(err)
	}
	if actor == nil || strings.TrimSpace(actor.ID) == "" || actor.ID != actorID || strings.TrimSpace(actor.Role) == "" {
		return nil, authRequiredError()
	}
	if actor.Kind != "" && actor.Kind != "human" {
		return nil, identityForbiddenError()
	}
	return actor, nil
}

func projectEvent(record EventRecord, payload map[string]any, actor *auth.Actor) Event {
	targetID := cloneStringPointer(record.TargetID)
	if record.Type == "transfer.rejected" {
		targetID = nil
	}
	target := (*EventTarget)(nil)
	if record.TargetType != nil && *record.TargetType != "" {
		target = &EventTarget{Type: *record.TargetType, ID: cloneStringPointer(targetID)}
	}
	return Event{
		ID:             record.ID,
		SpaceID:        record.SpaceID,
		Seq:            record.Seq,
		Type:           record.Type,
		ActorID:        cloneStringPointer(record.ActorID),
		ConversationID: cloneStringPointer(record.ConversationID),
		TargetType:     cloneStringPointer(record.TargetType),
		TargetID:       targetID,
		Target:         target,
		Payload:        projectPayload(record.Type, payload, actor),
		CreatedAt:      formatTimestamp(record.CreatedAt),
	}
}

func cloneStringPointer(value *string) *string {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func projectPayload(eventType string, payload map[string]any, actor *auth.Actor) map[string]any {
	if payload == nil {
		return map[string]any{}
	}
	if topicID := stringField(payload, "topicId"); topicID != "" && (strings.HasPrefix(eventType, "topic.") || eventType == "message.created") {
		result := map[string]any{"topicId": topicID}
		copyStringField(result, payload, "topicMessageId")
		copyStringField(result, payload, "projectionId")
		copyStringField(result, payload, "messageId")
		copyStringField(result, payload, "conversationId")
		if value, ok := payload["topicCard"].(bool); ok && value {
			result["topicCard"] = true
		}
		return result
	}
	switch eventType {
	case "workspace.member_joined", "workspace.member_updated":
		result := map[string]any{}
		copyStringField(result, payload, "userId")
		if member, ok := safeMember(payload["member"], actorID(actor)); ok {
			result["member"] = member
			if _, exists := result["role"]; !exists {
				copyStringField(result, member, "role")
			}
		} else {
			copyStringField(result, payload, "role")
		}
		return result
	case "workspace.member_visibility_updated", "workspace.member_removed":
		return stringFields(payload, "userId")
	case "conversation.created", "conversation.updated":
		result := stringFields(payload, "conversationId", "type", "title")
		if memberIDs := stringSliceField(payload, "memberIds"); len(memberIDs) > 0 {
			result["memberIds"] = memberIDs
		}
		if conversation, ok := safeConversation(payload["conversation"], actorID(actor)); ok {
			result["conversation"] = conversation
		}
		return result
	case "conversation.member_added":
		result := stringFields(payload, "conversationId", "userId")
		if member, ok := safeMember(payload["member"], actorID(actor)); ok {
			result["member"] = member
		}
		return result
	case "conversation.member_removed":
		result := stringFields(payload, "conversationId", "userId")
		if value, ok := payload["self"].(bool); ok && value {
			result["self"] = true
		}
		return result
	case "conversation.notification_updated":
		result := stringFields(payload, "conversationId", "userId", "notificationLevel")
		if conversation, ok := safeConversation(payload["conversation"], actorID(actor)); ok {
			result["conversation"] = conversation
		}
		return result
	case "emote.library.updated":
		result := stringFields(payload, "userId", "collectionId", "status")
		if value, ok := safeIntField(payload["sourceRevision"]); ok {
			result["sourceRevision"] = value
		}
		return result
	case "card.created", "card.updated", "card.invalidated":
		result := stringFields(payload, "cardId", "cardType", "status")
		if value, ok := safeIntField(payload["revision"]); ok {
			result["revision"] = value
		}
		return result
	case "message.created", "message.recalled":
		result := stringFields(payload, "messageId", "conversationId")
		if message, ok := safeMessage(payload["message"], actorID(actor)); ok {
			result["message"] = message
		}
		if conversation, ok := safeConversation(payload["conversation"], actorID(actor)); ok {
			result["conversation"] = conversation
		}
		return result
	case "reaction.added", "reaction.removed":
		result := stringFields(payload, "messageId", "conversationId")
		if reactions, ok := safeReactionGroups(payload["reactions"]); ok {
			result["reactions"] = reactions
		}
		return result
	case "message.pinned", "message.unpinned":
		return stringFields(payload, "messageId", "conversationId")
	case "attachment.created", "attachment.available", "attachment.failed", "attachment.removed":
		result := stringFields(payload, "attachmentId", "status")
		if attachment, ok := safeAttachment(payload["attachment"]); ok {
			result["attachment"] = attachment
		}
		return result
	case "transfer.rejected":
		return stringFields(payload, "direction", "code", "message", "reason")
	default:
		return map[string]any{}
	}
}

func stringField(value map[string]any, key string) string {
	text, _ := value[key].(string)
	return strings.TrimSpace(text)
}

func copyStringField(dst, src map[string]any, key string) {
	if value := stringField(src, key); value != "" {
		dst[key] = value
	}
}

func stringFields(src map[string]any, keys ...string) map[string]any {
	dst := make(map[string]any, len(keys))
	for _, key := range keys {
		copyStringField(dst, src, key)
	}
	return dst
}

func stringSliceField(src map[string]any, key string) []string {
	values, ok := src[key].([]any)
	if !ok {
		return nil
	}
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, item := range values {
		value, ok := item.(string)
		value = strings.TrimSpace(value)
		if !ok || value == "" {
			continue
		}
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result
}

func safeIntField(value any) (int64, bool) {
	switch number := value.(type) {
	case float64:
		if number < 0 || number > (1<<53-1) || math.Trunc(number) != number {
			return 0, false
		}
		return int64(number), true
	case int:
		if number < 0 {
			return 0, false
		}
		return int64(number), true
	case int64:
		if number < 0 {
			return 0, false
		}
		return number, true
	case string:
		parsed, err := strconv.ParseInt(strings.TrimSpace(number), 10, 64)
		if err != nil || parsed < 0 || parsed > (1<<53-1) {
			return 0, false
		}
		return parsed, true
	default:
		return 0, false
	}
}

func actorID(actor *auth.Actor) string {
	if actor == nil {
		return ""
	}
	return actor.ID
}

func safeMember(value any, viewerID string) (map[string]any, bool) {
	member, ok := value.(map[string]any)
	if !ok || member == nil {
		return nil, false
	}
	result := stringFields(member, "id", "githubLogin", "displayName", "description", "avatarUrl", "role", "roleLabel", "joinedAt")
	for _, key := range []string{"nickname"} {
		if raw, exists := member[key]; exists {
			if raw == nil {
				result[key] = nil
			} else if text, ok := raw.(string); ok {
				result[key] = text
			}
		}
	}
	memberID := stringField(member, "id")
	memberKind := stringField(member, "kind")
	if memberKind != "human" {
		delete(result, "githubLogin")
		delete(result, "nickname")
		delete(result, "remark")
	}
	if memberID != "" && memberID != viewerID {
		if raw, exists := member["remark"]; exists {
			if text, ok := raw.(string); ok {
				result["remark"] = text
			}
		}
	}
	if memberID != "" && memberID == viewerID {
		for _, key := range []string{"searchDiscoverable", "recallReason"} {
			if raw, exists := member[key]; exists {
				if key == "searchDiscoverable" {
					if value, ok := raw.(bool); ok {
						result[key] = value
					}
				} else if value, ok := raw.(string); ok {
					result[key] = value
				}
			}
		}
	}
	if memberKind != "" {
		result["kind"] = memberKind
	}
	if stringField(result, "displayName") == "" {
		if memberKind == "human" {
			if nickname := stringField(member, "nickname"); nickname != "" {
				result["displayName"] = nickname
			} else if login := stringField(member, "githubLogin"); login != "" {
				result["displayName"] = login
			} else {
				result["displayName"] = "成员"
			}
		} else {
			result["displayName"] = "Bot"
		}
	}
	if capabilities, ok := member["capabilities"].(map[string]any); ok {
		result["capabilities"] = map[string]any{
			"canStartDirectConversation": capabilities["canStartDirectConversation"] == true,
			"canJoinGroups":              capabilities["canJoinGroups"] == true,
			"canManage":                  capabilities["canManage"] == true,
		}
	}
	return result, true
}

func safeConversation(value any, viewerID string) (map[string]any, bool) {
	conversation, ok := value.(map[string]any)
	if !ok || conversation == nil {
		return nil, false
	}
	result := stringFields(conversation, "id", "spaceId", "type", "title", "displayTitle", "retentionText", "createdAt", "lastActivityAt", "lastMessagePlainText", "notificationLevel")
	for _, key := range []string{"avatarEmoji", "lastMessageAt", "lastReadMessageId", "lastReadAt"} {
		copyNullableStringField(result, conversation, key)
	}
	for _, key := range []string{"retentionCount", "messageCount", "memberCount", "unreadCount", "lastReadSeq"} {
		value, exists := conversation[key]
		if !exists {
			continue
		}
		if number, ok := safeIntField(value); ok {
			result[key] = number
		} else if key == "lastReadSeq" && value == nil {
			result[key] = nil
		}
	}
	if members, ok := conversation["members"].([]any); ok {
		publicMembers := make([]any, 0, len(members))
		for _, member := range members {
			if safe, ok := safeMember(member, viewerID); ok {
				publicMembers = append(publicMembers, safe)
			}
		}
		result["members"] = publicMembers
	}
	result["otherMember"] = nil
	if stringField(conversation, "type") == "direct" {
		if peer, exists := conversation["otherMember"]; exists {
			if peer != nil {
				if safe, ok := safeMember(peer, viewerID); ok {
					result["otherMember"] = safe
				}
			}
		}
	}
	if latest, ok := conversation["latestMessages"].([]any); ok {
		publicMessages := make([]any, 0, len(latest))
		for _, message := range latest {
			if safe, ok := safeMessage(message, viewerID); ok {
				publicMessages = append(publicMessages, safe)
			}
		}
		result["latestMessages"] = publicMessages
	}
	return result, true
}

func safeMessage(value any, viewerID string) (map[string]any, bool) {
	message, ok := value.(map[string]any)
	if !ok || message == nil {
		return nil, false
	}
	result := stringFields(message, "id", "conversationId", "authorName", "authorNickname", "authorRemark", "authorGithubLogin", "authorAvatarUrl", "authorKind", "kind", "plainText", "createdAt")
	for _, key := range []string{"authorId", "clientMessageId", "replyToMessageId", "editedAt", "deletedAt", "recalledAt", "recallReason"} {
		copyNullableStringField(result, message, key)
	}
	if content, ok := safeContent(message["content"]); ok {
		result["content"] = content
	}
	if attachments, ok := message["attachments"].([]any); ok {
		items := make([]any, 0, len(attachments))
		for _, attachment := range attachments {
			if safe, ok := safeAttachment(attachment); ok {
				items = append(items, safe)
			}
		}
		result["attachments"] = items
	}
	if reactions, ok := safeReactionGroups(message["reactions"]); ok {
		result["reactions"] = reactions
	}
	if pin, ok := message["pin"].(map[string]any); ok {
		publicPin := stringFields(pin, "pinnedByUserId", "pinnedAt")
		if canUnpin, ok := pin["canUnpin"].(bool); ok {
			publicPin["canUnpin"] = canUnpin
		}
		result["pin"] = publicPin
	}
	if hidden, ok := message["hiddenByCurrentUser"].(bool); ok {
		result["hiddenByCurrentUser"] = hidden
	}
	return result, true
}

func safeContent(value any) (map[string]any, bool) {
	content, ok := value.(map[string]any)
	if !ok || content == nil {
		return nil, false
	}
	result := stringFields(content, "format", "plainText")
	if blocks, ok := content["blocks"].([]any); ok {
		publicBlocks := make([]any, 0, len(blocks))
		for _, block := range blocks {
			if safe, ok := safeBlock(block); ok {
				publicBlocks = append(publicBlocks, safe)
			}
		}
		result["blocks"] = publicBlocks
	}
	return result, true
}

func safeBlock(value any) (map[string]any, bool) {
	block, ok := value.(map[string]any)
	if !ok || block == nil {
		return nil, false
	}
	typeName := stringField(block, "type")
	if typeName == "" {
		return nil, false
	}
	result := map[string]any{"type": typeName}
	for _, key := range []string{"text", "userId", "label", "url", "shortcode", "attachmentId", "shareId", "topicId", "title", "fallbackText"} {
		copyStringField(result, block, key)
	}
	if share, ok := safeEmoteCollectionShare(block["share"]); ok {
		result["share"] = share
	}
	return result, true
}

func safeEmoteCollectionShare(value any) (map[string]any, bool) {
	share, ok := value.(map[string]any)
	if !ok || share == nil {
		return nil, false
	}
	result := stringFields(share, "id", "name", "createdAt", "sharePath")
	if itemCount, ok := safeIntField(share["itemCount"]); ok {
		result["itemCount"] = itemCount
	}
	copyNullableStringField(result, share, "revokedAt")
	if canRevoke, ok := share["canRevoke"].(bool); ok {
		result["canRevoke"] = canRevoke
	}
	for _, key := range []string{"sharedBy", "originalCreator"} {
		person, ok := share[key].(map[string]any)
		if !ok {
			continue
		}
		result[key] = stringFields(person, "id", "displayName")
	}
	if covers, ok := share["covers"].([]any); ok {
		publicCovers := make([]any, 0, len(covers))
		for _, value := range covers {
			cover, ok := value.(map[string]any)
			if !ok || cover == nil {
				continue
			}
			projected := stringFields(cover, "id", "label", "src")
			if animated, ok := cover["animated"].(bool); ok {
				projected["animated"] = animated
			}
			publicCovers = append(publicCovers, projected)
		}
		result["covers"] = publicCovers
	}
	return result, true
}

func safeAttachment(value any) (map[string]any, bool) {
	attachment, ok := value.(map[string]any)
	if !ok || attachment == nil {
		return nil, false
	}
	result := stringFields(attachment, "id", "fileName", "mimeType", "status", "visibility", "uploaderId", "uploaderName", "createdAt")
	for _, key := range []string{"conversationId", "completedAt", "availableAt"} {
		copyNullableStringField(result, attachment, key)
	}
	if number, ok := safeIntField(attachment["byteSize"]); ok {
		result["byteSize"] = number
	}
	if uploader, ok := attachment["uploader"].(map[string]any); ok {
		result["uploader"] = stringFields(uploader, "id", "displayName")
	}
	if capabilities, ok := attachment["capabilities"].(map[string]any); ok {
		result["capabilities"] = map[string]any{
			"canDownload": capabilities["canDownload"] == true,
			"canRemove":   capabilities["canRemove"] == true,
		}
	}
	return result, true
}

func safeReactionGroups(value any) ([]any, bool) {
	groups, ok := value.([]any)
	if !ok {
		return nil, false
	}
	result := make([]any, 0, len(groups))
	for _, value := range groups {
		group, ok := value.(map[string]any)
		if !ok || group == nil {
			continue
		}
		item := stringFields(group, "emoteKey")
		if count, ok := safeIntField(group["count"]); ok {
			item["count"] = count
		}
		if reacted, ok := group["reactedByCurrentUser"].(bool); ok {
			item["reactedByCurrentUser"] = reacted
		}
		if users, ok := group["users"].([]any); ok {
			publicUsers := make([]any, 0, len(users))
			for _, value := range users {
				user, ok := value.(map[string]any)
				if !ok {
					continue
				}
				publicUsers = append(publicUsers, stringFields(user, "id", "displayName", "githubLogin", "avatarUrl", "createdAt"))
			}
			item["users"] = publicUsers
		}
		result = append(result, item)
	}
	return result, true
}

func copyNullableStringField(dst, src map[string]any, key string) {
	value, exists := src[key]
	if !exists {
		return
	}
	switch typed := value.(type) {
	case nil:
		dst[key] = nil
	case string:
		if trimmed := strings.TrimSpace(typed); trimmed != "" {
			dst[key] = trimmed
		} else {
			dst[key] = nil
		}
	case *string:
		if typed == nil {
			dst[key] = nil
		} else if trimmed := strings.TrimSpace(*typed); trimmed != "" {
			dst[key] = trimmed
		} else {
			dst[key] = nil
		}
	}
}
