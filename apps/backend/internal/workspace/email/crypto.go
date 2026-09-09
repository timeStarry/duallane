package email

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
)

var emailPattern = regexp.MustCompile(`^[^\s@]+@[^\s@]+\.[^\s@]+$`)

func newUUID() (string, error) {
	id, err := uuid.NewRandom()
	if err != nil {
		return "", err
	}
	return id.String(), nil
}

func randomCode() (string, error) {
	var bytes [4]byte
	if _, err := io.ReadFull(rand.Reader, bytes[:]); err != nil {
		return "", err
	}
	value := uint32(bytes[0])<<24 | uint32(bytes[1])<<16 | uint32(bytes[2])<<8 | uint32(bytes[3])
	return fmt.Sprintf("%06d", value%1_000_000), nil
}

func decodeEncryptionKey(value []byte, encoded string) ([]byte, error) {
	if len(value) > 0 {
		if len(value) != 32 {
			return nil, newError(CodeEncryptionUnconfigured, MessageEncryptionMissing, 503)
		}
		return append([]byte(nil), value...), nil
	}
	encoded = strings.TrimSpace(encoded)
	if encoded == "" {
		return nil, newError(CodeEncryptionUnconfigured, MessageEncryptionMissing, 503)
	}
	decoded, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		decoded, err = base64.RawStdEncoding.DecodeString(encoded)
	}
	if err != nil || len(decoded) != 32 {
		return nil, newError(CodeEncryptionUnconfigured, MessageEncryptionMissing, 503)
	}
	return decoded, nil
}

func encryptSecret(value string, key []byte, associatedData string) (string, error) {
	if len(key) != 32 {
		return "", newError(CodeEncryptionUnconfigured, MessageEncryptionMissing, 503)
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", newError(CodeCredentialUnavailable, MessageCredentialUnavailable, 503)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", newError(CodeCredentialUnavailable, MessageCredentialUnavailable, 503)
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", newError(CodeCredentialUnavailable, MessageCredentialUnavailable, 503)
	}
	sealed := gcm.Seal(nil, nonce, []byte(value), []byte(associatedData))
	if len(sealed) < gcm.Overhead() {
		return "", newError(CodeCredentialUnavailable, MessageCredentialUnavailable, 503)
	}
	ciphertext := sealed[:len(sealed)-gcm.Overhead()]
	tag := sealed[len(sealed)-gcm.Overhead():]
	return strings.Join([]string{
		"v1",
		base64.RawURLEncoding.EncodeToString(nonce),
		base64.RawURLEncoding.EncodeToString(tag),
		base64.RawURLEncoding.EncodeToString(ciphertext),
	}, "."), nil
}

func decryptSecret(value string, key []byte, associatedData string) (string, error) {
	parts := strings.Split(strings.TrimSpace(value), ".")
	if len(parts) != 4 || parts[0] != "v1" || parts[1] == "" || parts[2] == "" {
		return "", newError(CodeCredentialUnavailable, MessageCredentialUnavailable, 503)
	}
	if len(key) != 32 {
		return "", newError(CodeCredentialUnavailable, MessageCredentialUnavailable, 503)
	}
	nonce, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "", newError(CodeCredentialUnavailable, MessageCredentialUnavailable, 503)
	}
	tag, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return "", newError(CodeCredentialUnavailable, MessageCredentialUnavailable, 503)
	}
	ciphertext, err := base64.RawURLEncoding.DecodeString(parts[3])
	if err != nil {
		return "", newError(CodeCredentialUnavailable, MessageCredentialUnavailable, 503)
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", newError(CodeCredentialUnavailable, MessageCredentialUnavailable, 503)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil || len(nonce) != gcm.NonceSize() || len(tag) != gcm.Overhead() {
		return "", newError(CodeCredentialUnavailable, MessageCredentialUnavailable, 503)
	}
	sealed := append(append([]byte(nil), ciphertext...), tag...)
	plaintext, err := gcm.Open(nil, nonce, sealed, []byte(associatedData))
	if err != nil || !utf8.Valid(plaintext) {
		return "", newError(CodeCredentialUnavailable, MessageCredentialUnavailable, 503)
	}
	return string(plaintext), nil
}

func smtpFingerprint(config MailConfig, key []byte) string {
	body, _ := json.Marshal([]any{
		config.SMTPHost,
		config.SMTPPort,
		config.Encryption,
		config.Username,
		config.Password,
		config.FromAddress,
		config.FromName,
	})
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write(body)
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

type testProofPayload struct {
	ActorID     string `json:"actorId"`
	Fingerprint string `json:"fingerprint"`
	ExpiresAt   int64  `json:"expiresAt"`
}

func signTestProof(key []byte, payload testProofPayload) (string, error) {
	if len(key) != 32 {
		return "", newError(CodeEncryptionUnconfigured, MessageEncryptionMissing, 503)
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return "", newError(CodeCredentialUnavailable, MessageCredentialUnavailable, 503)
	}
	bodyEncoded := base64.RawURLEncoding.EncodeToString(body)
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(bodyEncoded))
	signature := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return bodyEncoded + "." + signature, nil
}

func verifyTestProof(key []byte, value, actorID, fingerprint string, currentTime int64) bool {
	parts := strings.Split(strings.TrimSpace(value), ".")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" || len(key) != 32 {
		return false
	}
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(parts[0]))
	expected, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || !hmac.Equal(expected, mac.Sum(nil)) {
		return false
	}
	body, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return false
	}
	var payload testProofPayload
	if json.Unmarshal(body, &payload) != nil {
		return false
	}
	return payload.ActorID == actorID && payload.Fingerprint == fingerprint && payload.ExpiresAt > currentTime
}

func challengeHash(key []byte, id, code string) string {
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(id + ":" + code))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func normalizeEmail(value string) (string, error) {
	email := strings.ToLower(strings.TrimSpace(value))
	if !emailPattern.MatchString(email) || len(email) > 320 {
		return "", newError(CodeInvalidEmail, MessageInvalidEmail, 400)
	}
	return email, nil
}

func normalizeSMTPDraft(input SMTPDraft, existingPassword string) (MailConfig, error) {
	host := strings.TrimSpace(input.SMTPHost)
	port := input.SMTPPort
	if host == "" || len(host) > 253 || port < 1 || port > 65535 {
		return MailConfig{}, newError(CodeSMTPInvalid, MessageSMTPInvalid, 400)
	}
	encryption := strings.TrimSpace(input.Encryption)
	if encryption == "" {
		encryption = "starttls"
	}
	if encryption != "starttls" && encryption != "tls" && encryption != "none" {
		return MailConfig{}, newError(CodeSMTPInvalid, "请选择有效的加密方式", 400)
	}
	username := strings.TrimSpace(input.Username)
	password := input.Password
	if password == "" {
		password = existingPassword
	}
	if (username == "") != (password == "") {
		return MailConfig{}, newError(CodeSMTPAuthInvalid, MessageSMTPAuthInvalid, 400)
	}
	fromName := strings.TrimSpace(input.FromName)
	if fromName == "" {
		fromName = "DualLane"
	}
	fromAddress := strings.TrimSpace(input.FromAddress)
	if fromAddress == "" && emailPattern.MatchString(username) {
		fromAddress = username
	}
	if !emailPattern.MatchString(fromAddress) || len(fromName) > 80 || len(username) > 320 || len(password) > 4096 {
		return MailConfig{}, newError(CodeSMTPInvalid, "请填写有效的发信信息", 400)
	}
	return MailConfig{SMTPHost: host, SMTPPort: port, Encryption: encryption, Username: username, Password: password, FromAddress: fromAddress, FromName: fromName}, nil
}

func maskEmail(value string) string {
	parts := strings.SplitN(value, "@", 2)
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return ""
	}
	stars := len([]rune(parts[0])) - 1
	if stars < 2 {
		stars = 2
	}
	if stars > 6 {
		stars = 6
	}
	first, _ := utf8.DecodeRuneInString(parts[0])
	return string(first) + strings.Repeat("*", stars) + "@" + parts[1]
}

func formatTime(value time.Time) string {
	return value.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
}

func normalizeTime(value time.Time) time.Time {
	return value.UTC().Truncate(time.Millisecond)
}

func optionalTime(value *time.Time) *string {
	if value == nil {
		return nil
	}
	formatted := formatTime(*value)
	return &formatted
}

func optionalString(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func isUnread(eventSeq int64, lastReadSeq *int64, createdAt time.Time, lastReadAt *time.Time) bool {
	if lastReadSeq != nil {
		return eventSeq > *lastReadSeq
	}
	return lastReadAt == nil || createdAt.After(*lastReadAt)
}

func messageMentions(raw []byte, userID string) bool {
	if len(raw) == 0 || len(raw) > 256*1024 {
		return false
	}
	var content struct {
		Blocks []struct {
			Type   string `json:"type"`
			UserID string `json:"userId"`
		} `json:"blocks"`
	}
	if json.Unmarshal(raw, &content) != nil {
		return false
	}
	for _, block := range content.Blocks {
		if block.Type == "mention" && block.UserID == userID {
			return true
		}
	}
	return false
}

func bodyWithNoContent(title, body, baseURL string) Message {
	baseURL = normalizeBaseURL(baseURL)
	return Message{
		Subject: "DualLane：" + title,
		Text:    body + "\n\n打开共享空间：" + baseURL + "\n\n此邮件不会展示消息正文或附件内容。",
		HTML:    buildHTML(title, body, baseURL),
	}
}

func buildHTML(title, body, baseURL string) string {
	return "<!doctype html><html lang=\"zh-CN\"><body style=\"margin:0;background:#f5f4ef;color:#1f2928;font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif\"><div style=\"max-width:560px;margin:0 auto;padding:32px 20px\"><div style=\"border:1px solid #d9dedb;background:#ffffff;padding:28px\"><div style=\"font-size:14px;font-weight:600;color:#168579\">DualLane</div><h1 style=\"margin:18px 0 12px;font-size:22px;line-height:1.35\">" + escapeHTML(title) + "</h1><p style=\"margin:0 0 24px;font-size:15px;line-height:1.7;color:#45504e\">" + escapeHTML(body) + "</p><a href=\"" + escapeHTML(baseURL) + "\" style=\"display:inline-block;background:#168579;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:6px;font-weight:600\">打开共享空间</a><p style=\"margin:28px 0 0;font-size:12px;line-height:1.6;color:#77817f\">此邮件不会展示消息正文、会话名称或附件内容。通知偏好可在个人设置中修改。</p></div></div></body></html>"
}

func escapeHTML(value string) string {
	value = strings.ReplaceAll(value, "&", "&amp;")
	value = strings.ReplaceAll(value, "<", "&lt;")
	value = strings.ReplaceAll(value, ">", "&gt;")
	value = strings.ReplaceAll(value, "\"", "&quot;")
	return strings.ReplaceAll(value, "'", "&#39;")
}

func normalizeBaseURL(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		value = DefaultFrontendURL
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return DefaultFrontendURL + "/workspace"
	}
	parsed.Path = "/workspace"
	parsed.RawPath = ""
	return parsed.String()
}

func safeMailConfig(config MailConfig) bool {
	return strings.TrimSpace(config.SMTPHost) != "" && config.SMTPPort > 0 && config.SMTPPort <= 65535 &&
		(config.Encryption == "starttls" || config.Encryption == "tls" || config.Encryption == "none") &&
		emailPattern.MatchString(config.FromAddress)
}

func safeRecipient(value string) bool {
	return emailPattern.MatchString(strings.TrimSpace(value)) && len(value) <= 320
}
