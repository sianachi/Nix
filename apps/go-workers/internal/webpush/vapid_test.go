package webpush

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"strings"
	"testing"
	"time"
)

func TestVAPIDAuthorizationSignatureVerifies(t *testing.T) {
	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate VAPID key: %v", err)
	}
	now := time.Date(2026, 9, 29, 12, 0, 0, 0, time.UTC)
	header, err := VAPIDAuthorization(privateKey, "https://fcm.googleapis.com/fcm/send/abc123", "mailto:push@example.com", now)
	if err != nil {
		t.Fatalf("VAPIDAuthorization: %v", err)
	}
	if !strings.HasPrefix(header, "vapid t=") {
		t.Fatalf("unexpected authorization scheme: %q", header)
	}
	token, key := parseVAPIDHeader(t, header)

	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		t.Fatalf("JWT must have three dot-separated parts, got %d", len(parts))
	}
	headerJSON, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		t.Fatalf("decode JWT header: %v", err)
	}
	if string(headerJSON) != `{"typ":"JWT","alg":"ES256"}` {
		t.Fatalf("unexpected JWT header: %s", headerJSON)
	}
	claimsJSON, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		t.Fatalf("decode JWT claims: %v", err)
	}
	var claims vapidClaims
	if err := json.Unmarshal(claimsJSON, &claims); err != nil {
		t.Fatalf("unmarshal JWT claims: %v", err)
	}
	if claims.Audience != "https://fcm.googleapis.com" {
		t.Fatalf("unexpected audience: %s", claims.Audience)
	}
	if claims.Subject != "mailto:push@example.com" {
		t.Fatalf("unexpected subject: %s", claims.Subject)
	}
	if maxExpiry := now.Add(12 * time.Hour).Unix(); claims.Expiry != maxExpiry {
		t.Fatalf("expiry = %d, want %d (12h)", claims.Expiry, maxExpiry)
	}

	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		t.Fatalf("decode JWT signature: %v", err)
	}
	if len(signature) != 64 {
		t.Fatalf("ES256 signature must be 64 bytes, got %d", len(signature))
	}
	r := new(big.Int).SetBytes(signature[:32])
	s := new(big.Int).SetBytes(signature[32:])
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if !ecdsa.Verify(&privateKey.PublicKey, digest[:], r, s) {
		t.Fatal("VAPID JWT signature does not verify against the signing key")
	}

	keyBytes, err := base64.RawURLEncoding.DecodeString(key)
	if err != nil {
		t.Fatalf("decode k parameter: %v", err)
	}
	expectedKeyBytes, err := privateKey.PublicKey.Bytes()
	if err != nil {
		t.Fatalf("encode expected public key: %v", err)
	}
	if string(keyBytes) != string(expectedKeyBytes) {
		t.Fatal("k parameter does not match the signing key's public key")
	}
}

func TestVAPIDAuthorizationRejectsNonHTTPSEndpoint(t *testing.T) {
	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate VAPID key: %v", err)
	}
	if _, err := VAPIDAuthorization(privateKey, "http://fcm.googleapis.com/fcm/send/abc123", "mailto:push@example.com", time.Now()); err == nil {
		t.Fatal("expected a non-HTTPS endpoint to be rejected")
	}
}

func TestParseVAPIDPrivateKeyRejectsWrongLength(t *testing.T) {
	if _, err := ParseVAPIDPrivateKey(make([]byte, 31)); err == nil {
		t.Fatal("expected a non-32-byte key to be rejected")
	}
}

// parseVAPIDHeader extracts t= and k= from `vapid t=<token>, k=<key>`.
func parseVAPIDHeader(t *testing.T, header string) (token, key string) {
	t.Helper()
	body := strings.TrimPrefix(header, "vapid ")
	for _, field := range strings.Split(body, ", ") {
		name, value, ok := strings.Cut(field, "=")
		if !ok {
			continue
		}
		switch name {
		case "t":
			token = value
		case "k":
			key = value
		}
	}
	if token == "" || key == "" {
		t.Fatalf("could not parse vapid header: %q", header)
	}
	return token, key
}
