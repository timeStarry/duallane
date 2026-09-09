package p2p

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"fmt"
	"time"
)

func makeTURNCredential(secret string, ttl time.Duration, now time.Time) (string, string) {
	if ttl <= 0 {
		ttl = 10 * time.Minute
	}
	expiresAt := now.Unix() + int64(ttl/time.Second)
	username := fmt.Sprintf("%d:duallane", expiresAt)
	mac := hmac.New(sha1.New, []byte(secret))
	_, _ = mac.Write([]byte(username))
	return username, base64.StdEncoding.EncodeToString(mac.Sum(nil))
}
