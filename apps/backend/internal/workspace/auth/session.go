package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
)

const (
	DefaultSpaceID          = "spc_default"
	SeededOwnerID           = "usr_owner"
	SeededOwnerGitHubLogin  = "timeStarry"
	SeededOwnerEmail        = "timestarry@qq.com"
	SessionCookieName       = "duallane_workspace"
	OAuthStateCookieName    = "duallane_oauth_state"
	PendingInviteCookieName = "duallane_pending_invite"
	OAuthReturnCookieName   = "duallane_oauth_return"
	OAuthCookiePath         = "/api/auth/github"
	SessionCookiePath       = "/"
	DefaultSessionTTL       = 14 * 24 * time.Hour
	SessionTokenBytes       = 32
)

// Actor is the server-derived identity used by Workspace operations. Role is
// populated only for an active membership in DefaultSpaceID.
type Actor struct {
	ID                 string
	GitHubID           string
	GitHubLogin        string
	Email              string
	DisplayName        string
	Nickname           string
	AvatarURL          string
	SearchDiscoverable bool
	Kind               string
	Role               string
	JoinedAt           time.Time
}

type GitHubProfile struct {
	ID        string
	Login     string
	Email     string
	Name      string
	AvatarURL string
}

type Session struct {
	ID        string
	Token     string
	ExpiresAt time.Time
	UserID    string
}

type SessionRecord struct {
	ID        string
	TokenHash string
	UserID    string
	CreatedAt time.Time
	ExpiresAt time.Time
}

// Store is the intentionally narrow persistence seam for this vertical
// slice. Implementations must enforce active human membership in session
// creation and lookup, and must perform identity/invite writes atomically.
// Raw session tokens never cross this interface; callers pass only TokenHash.
type Store interface {
	CreateSession(ctx context.Context, record SessionRecord) error
	LookupSessionActor(ctx context.Context, tokenHash string, now time.Time) (*Actor, error)
	RevokeSession(ctx context.Context, tokenHash string, now time.Time) (bool, error)
	AuthenticateGitHub(ctx context.Context, profile GitHubProfile, inviteCodeHash string, now time.Time, meta RequestMeta) (*Actor, error)
	RecordGitHubLoginRejection(ctx context.Context, phase string, now time.Time, meta RequestMeta) error
	RecordInviteAcceptRejection(ctx context.Context, reason string, now time.Time, meta RequestMeta) error
}

// ActiveActorLookup is an optional extension used solely by the
// non-production development identity header. Keeping it separate means
// stores that only serve cookie sessions do not gain a broader required API.
type ActiveActorLookup interface {
	LookupActiveActorByID(ctx context.Context, userID string) (*Actor, error)
}

type Pinger interface {
	Ping(ctx context.Context) error
}

type Clock func() time.Time
type IDFactory func() (string, error)

type Service struct {
	store     Store
	ttl       time.Duration
	now       Clock
	idFactory IDFactory
}

type ServiceOptions struct {
	Store      Store
	SessionTTL time.Duration
	Now        Clock
	IDFactory  IDFactory
}

func NewService(options ServiceOptions) *Service {
	ttl := options.SessionTTL
	if ttl <= 0 {
		ttl = DefaultSessionTTL
	}
	now := options.Now
	if now == nil {
		now = time.Now
	}
	idFactory := options.IDFactory
	if idFactory == nil {
		idFactory = newUUID
	}
	return &Service{store: options.Store, ttl: ttl, now: now, idFactory: idFactory}
}

func (s *Service) Store() Store {
	if s == nil {
		return nil
	}
	return s.store
}

func (s *Service) CreateSession(ctx context.Context, userID string) (Session, error) {
	if s == nil || s.store == nil || strings.TrimSpace(userID) == "" {
		return Session{}, requiredError()
	}
	now := normalizedNow(s.now)
	id, err := s.idFactory()
	if err != nil || strings.TrimSpace(id) == "" {
		if err == nil {
			err = errors.New("id factory returned an empty id")
		}
		return Session{}, wrapInternal("generate session id", err)
	}
	token, err := NewSessionToken()
	if err != nil {
		return Session{}, wrapInternal("generate session token", err)
	}
	session := Session{
		ID:        id,
		Token:     token,
		ExpiresAt: now.Add(s.ttl),
		UserID:    strings.TrimSpace(userID),
	}
	record := SessionRecord{
		ID:        session.ID,
		TokenHash: HashSecret(token),
		UserID:    session.UserID,
		CreatedAt: now,
		ExpiresAt: session.ExpiresAt,
	}
	if err := s.store.CreateSession(ctx, record); err != nil {
		if isCode(err, CodeRequired) {
			return Session{}, requiredError()
		}
		return Session{}, err
	}
	return session, nil
}

func (s *Service) ResolveActor(ctx context.Context, token string) (*Actor, error) {
	if s == nil || s.store == nil || strings.TrimSpace(token) == "" {
		return nil, requiredError()
	}
	actor, err := s.store.LookupSessionActor(ctx, HashSecret(token), normalizedNow(s.now))
	if err != nil {
		return nil, err
	}
	if actor == nil || actor.Kind != "human" || strings.TrimSpace(actor.ID) == "" || strings.TrimSpace(actor.Role) == "" {
		return nil, requiredError()
	}
	return actor, nil
}

// ResolveActorID is intentionally used only by the non-production development
// header boundary. The store still has to resolve an active human membership;
// the header is never treated as an authorization grant by itself.
func (s *Service) ResolveActorID(ctx context.Context, userID string) (*Actor, error) {
	if s == nil || s.store == nil {
		return nil, requiredError()
	}
	userID = normalizeField(userID, 256)
	if userID == "" {
		return nil, requiredError()
	}
	lookup, ok := s.store.(ActiveActorLookup)
	if !ok {
		return nil, requiredError()
	}
	actor, err := lookup.LookupActiveActorByID(ctx, userID)
	if err != nil {
		return nil, err
	}
	if actor == nil || actor.Kind != "human" || strings.TrimSpace(actor.ID) == "" || strings.TrimSpace(actor.Role) == "" {
		return nil, requiredError()
	}
	return actor, nil
}

func (s *Service) ResolveActorFromRequest(ctx context.Context, request *http.Request) (*Actor, error) {
	if request == nil {
		return nil, requiredError()
	}
	cookie, err := request.Cookie(SessionCookieName)
	if err != nil {
		return nil, requiredError()
	}
	return s.ResolveActor(ctx, cookie.Value)
}

func (s *Service) RevokeSession(ctx context.Context, token string) (bool, error) {
	if s == nil || s.store == nil || strings.TrimSpace(token) == "" {
		return false, nil
	}
	return s.store.RevokeSession(ctx, HashSecret(token), normalizedNow(s.now))
}

func (s *Service) AuthenticateGitHub(ctx context.Context, profile GitHubProfile, pendingInvite string, requestMeta ...RequestMeta) (*Actor, error) {
	if s == nil || s.store == nil {
		return nil, requiredError()
	}
	profile, err := NormalizeGitHubProfile(profile)
	if err != nil {
		return nil, err
	}
	inviteHash := ""
	if normalized := NormalizeInviteCode(pendingInvite); normalized != "" {
		inviteHash = HashSecret(normalized)
	}
	meta := RequestMeta{}
	if len(requestMeta) > 0 {
		meta = requestMeta[0]
	}
	actor, err := s.store.AuthenticateGitHub(ctx, profile, inviteHash, normalizedNow(s.now), meta.Safe())
	if err != nil {
		return nil, err
	}
	if actor == nil || actor.Kind != "human" || strings.TrimSpace(actor.ID) == "" || strings.TrimSpace(actor.Role) == "" {
		return nil, requiredError()
	}
	return actor, nil
}

func (s *Service) RecordGitHubLoginRejection(ctx context.Context, phase string, requestMeta ...RequestMeta) error {
	if s == nil || s.store == nil {
		return wrapInternal("record github rejection", requiredError())
	}
	safePhase := normalizeOAuthFailurePhase(phase)
	meta := RequestMeta{}
	if len(requestMeta) > 0 {
		meta = requestMeta[0]
	}
	return s.store.RecordGitHubLoginRejection(ctx, safePhase, normalizedNow(s.now), meta.Safe())
}

func (s *Service) RecordInviteAcceptRejection(ctx context.Context, reason string, requestMeta ...RequestMeta) error {
	if s == nil || s.store == nil {
		return wrapInternal("record invite acceptance rejection", requiredError())
	}
	meta := RequestMeta{}
	if len(requestMeta) > 0 {
		meta = requestMeta[0]
	}
	return s.store.RecordInviteAcceptRejection(ctx, normalizeInviteRejectionReason(reason), normalizedNow(s.now), meta.Safe())
}

func normalizeInviteRejectionReason(reason string) string {
	switch strings.TrimSpace(reason) {
	case CodeGitHubRequired:
		return CodeGitHubRequired
	default:
		return CodeInviteInvalid
	}
}

func NewSessionToken() (string, error) {
	bytes := make([]byte, SessionTokenBytes)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(bytes), nil
}

func HashSecret(secret string) string {
	digest := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(digest[:])
}

func EqualSecret(left, right string) bool {
	return subtle.ConstantTimeCompare([]byte(left), []byte(right)) == 1
}

func SessionCookie(session Session, secure bool) http.Cookie {
	return http.Cookie{
		Name:     SessionCookieName,
		Value:    session.Token,
		Path:     SessionCookiePath,
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
		Expires:  session.ExpiresAt.UTC(),
	}
}

func ClearSessionCookie(secure bool) http.Cookie {
	return clearCookie(SessionCookieName, SessionCookiePath, secure)
}

func OAuthCookie(name, value string, secure bool, _ time.Time) http.Cookie {
	return http.Cookie{
		Name:     name,
		Value:    value,
		Path:     OAuthCookiePath,
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
	}
}

func ClearOAuthCookie(name string, secure bool) http.Cookie {
	return clearCookie(name, OAuthCookiePath, secure)
}

func clearCookie(name, path string, secure bool) http.Cookie {
	return http.Cookie{
		Name:     name,
		Value:    "",
		Path:     path,
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
		Expires:  time.Unix(1, 0).UTC(),
	}
}

func PublicActor(actor *Actor) map[string]any {
	if actor == nil {
		return nil
	}
	displayName := actor.DisplayName
	value := map[string]any{
		"id":          actor.ID,
		"githubLogin": actor.GitHubLogin,
		"displayName": displayName,
		"avatarUrl":   actor.AvatarURL,
		"kind":        actor.Kind,
		"role":        actor.Role,
	}
	if actor.Kind == "human" {
		if actor.Nickname != "" {
			displayName = actor.Nickname
		} else if actor.GitHubLogin != "" {
			displayName = actor.GitHubLogin
		}
		value["displayName"] = displayName
		if actor.Nickname == "" {
			value["nickname"] = nil
		} else {
			value["nickname"] = actor.Nickname
		}
		value["searchDiscoverable"] = actor.SearchDiscoverable
	}
	if !actor.JoinedAt.IsZero() {
		value["joinedAt"] = externalTime(actor.JoinedAt)
	}
	return value
}

// PublicMemberProjection is the member shape embedded in a member-joined
// event. It mirrors the server's viewer-independent publicMember projection;
// an event reader may refine capabilities for the receiving actor later.
func PublicMemberProjection(actor *Actor) map[string]any {
	if actor == nil {
		return nil
	}
	displayName := actor.DisplayName
	value := map[string]any{
		"id":          actor.ID,
		"displayName": displayName,
		"avatarUrl":   actor.AvatarURL,
		"kind":        actor.Kind,
		"role":        publicMemberRole(actor.Role),
		"roleLabel":   publicRoleLabel(actor.Role),
		"capabilities": map[string]bool{
			"canStartDirectConversation": false,
			"canJoinGroups":              canJoinGroups(actor),
			"canManage":                  false,
		},
	}
	if actor.Kind == "human" {
		if actor.Nickname != "" {
			displayName = actor.Nickname
		} else if actor.GitHubLogin != "" {
			displayName = actor.GitHubLogin
		} else {
			displayName = "成员"
		}
		value["githubLogin"] = actor.GitHubLogin
		if actor.Nickname == "" {
			value["nickname"] = nil
		} else {
			value["nickname"] = actor.Nickname
		}
		value["displayName"] = displayName
	} else if displayName == "" {
		value["displayName"] = "Bot"
	}
	if !actor.JoinedAt.IsZero() {
		value["joinedAt"] = externalTime(actor.JoinedAt)
	}
	return value
}

func NormalizeInviteCode(value string) string {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 256 {
		return ""
	}
	for _, character := range value {
		if character < 0x21 || character > 0x7e || character == ';' || character == ',' || character == '\\' || character == '"' {
			return ""
		}
	}
	return value
}

func NormalizeGitHubProfile(profile GitHubProfile) (GitHubProfile, error) {
	profile.ID = normalizeField(profile.ID, 128)
	profile.Login = normalizeField(profile.Login, 256)
	profile.Email = normalizeField(profile.Email, 320)
	profile.Name = normalizeField(profile.Name, 256)
	profile.AvatarURL = normalizeGitHubAvatarURL(profile.AvatarURL)
	if profile.Login == "" && profile.Email == "" && profile.ID == "" {
		return GitHubProfile{}, invalidProfileError()
	}
	if profile.Name == "" {
		profile.Name = profile.Login
	}
	return profile, nil
}

func normalizeField(value string, maxBytes int) string {
	value = strings.TrimSpace(value)
	if len(value) > maxBytes {
		return ""
	}
	for _, character := range value {
		if character < 0x20 || character == 0x7f {
			return ""
		}
	}
	return value
}

func normalizeGitHubAvatarURL(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	u, err := url.ParseRequestURI(value)
	if err != nil || u.Scheme != "https" || u.Hostname() != "avatars.githubusercontent.com" || u.User != nil || u.Port() != "" {
		return ""
	}
	return u.String()
}

func newUUID() (string, error) {
	id, err := uuid.NewRandom()
	if err != nil {
		return "", err
	}
	return id.String(), nil
}

func normalizedNow(clock Clock) time.Time {
	if clock == nil {
		clock = time.Now
	}
	now := clock()
	if now.IsZero() {
		now = time.Now()
	}
	return now.UTC().Truncate(time.Millisecond)
}

func normalizeTimestamp(value time.Time) time.Time {
	if value.IsZero() {
		return normalizedNow(nil)
	}
	return value.UTC().Truncate(time.Millisecond)
}

func externalTime(value time.Time) string {
	if value.IsZero() {
		return ""
	}
	return value.UTC().Format("2006-01-02T15:04:05.000Z")
}

func publicMemberRole(role string) string {
	switch role {
	case "owner":
		return "admin"
	case "auditor":
		return "member"
	case "admin", "member":
		return role
	default:
		return "member"
	}
}

func publicRoleLabel(role string) string {
	switch publicMemberRole(role) {
	case "admin":
		return "管理员"
	default:
		return "成员"
	}
}

func canJoinGroups(actor *Actor) bool {
	if actor == nil || actor.Kind != "human" {
		return false
	}
	return actor.Role == "owner" || actor.Role == "admin" || actor.Role == "member"
}

func normalizeOAuthFailurePhase(value string) string {
	switch value {
	case "token", "profile", "email":
		return value
	default:
		return "exchange"
	}
}
