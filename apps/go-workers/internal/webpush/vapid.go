package webpush

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"time"
)

// VAPIDLifetime is this worker's token lifetime, well inside the RFC 8292
// Section 2 24-hour ceiling.
const VAPIDLifetime = 12 * time.Hour

// ParseVAPIDPrivateKey parses a raw (not PKCS8, not PEM) P-256 scalar, the
// format NIX_PUSH_VAPID_PRIVATE_KEY is delivered in: 32 bytes, base64url
// decoded by the caller.
func ParseVAPIDPrivateKey(raw []byte) (*ecdsa.PrivateKey, error) {
	if len(raw) != 32 {
		return nil, errors.New("VAPID private key must be 32 raw bytes")
	}
	return ecdsa.ParseRawPrivateKey(elliptic.P256(), raw)
}

type vapidClaims struct {
	Audience string `json:"aud"`
	Expiry   int64  `json:"exp"`
	Subject  string `json:"sub"`
}

// VAPIDAuthorization builds the RFC 8292 "vapid" Authorization header value
// for a push request to endpoint, self-identifying with subject (a mailto: or
// https: URI) and signed with privateKey (ES256). now is the signing time;
// the token expires VAPIDLifetime after it.
func VAPIDAuthorization(privateKey *ecdsa.PrivateKey, endpoint, subject string, now time.Time) (string, error) {
	if privateKey == nil {
		return "", errors.New("VAPID private key is not configured")
	}
	audience, err := pushOrigin(endpoint)
	if err != nil {
		return "", err
	}
	claims, err := json.Marshal(vapidClaims{
		Audience: audience,
		Expiry:   now.Add(VAPIDLifetime).Unix(),
		Subject:  subject,
	})
	if err != nil {
		return "", err
	}
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"typ":"JWT","alg":"ES256"}`))
	body := base64.RawURLEncoding.EncodeToString(claims)
	signingInput := header + "." + body
	digest := sha256.Sum256([]byte(signingInput))
	r, s, err := ecdsa.Sign(rand.Reader, privateKey, digest[:])
	if err != nil {
		return "", err
	}
	signature := make([]byte, 64)
	r.FillBytes(signature[:32])
	s.FillBytes(signature[32:])
	token := signingInput + "." + base64.RawURLEncoding.EncodeToString(signature)
	publicKeyBytes, err := privateKey.PublicKey.Bytes()
	if err != nil {
		return "", err
	}
	key := base64.RawURLEncoding.EncodeToString(publicKeyBytes)
	return fmt.Sprintf("vapid t=%s, k=%s", token, key), nil
}

// pushOrigin returns the Unicode serialization of the push resource URL's
// origin (RFC 8292 Section 2, "aud" claim): scheme and host only, https only.
func pushOrigin(endpoint string) (string, error) {
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil {
		return "", errors.New("push endpoint is not a valid HTTPS URL")
	}
	return parsed.Scheme + "://" + parsed.Host, nil
}
