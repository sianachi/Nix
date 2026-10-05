// Package webpush implements the receiver-facing halves of Web Push message
// encryption (RFC 8291) and application server self-identification (RFC 8292,
// VAPID) using only the Go standard library. Nothing here talks to the
// network; internal/pushtransport does that.
package webpush

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"errors"
)

const (
	// RecordSize is the single aes128gcm record size a push message is encrypted
	// with (RFC 8291 Section 4: an application server MUST encrypt with a single
	// record).
	RecordSize = 4096
	// headerSize is the fixed aes128gcm header length for a P-256 keyid: 16-byte
	// salt, 4-byte record size, 1-byte key length, 65-byte uncompressed key.
	headerSize = 16 + 4 + 1 + 65
	// MaxPlaintextBytes bounds the plaintext this package accepts so the sealed
	// record (plaintext + 1-byte padding delimiter + 16-byte AEAD tag) never
	// exceeds RecordSize.
	MaxPlaintextBytes = RecordSize - 1 - 16

	uncompressedP256PointSize = 65
	authSecretSize            = 16
)

var webPushInfoPrefix = []byte("WebPush: info\x00")

// Encrypt seals plaintext for delivery to a push subscription per RFC 8291.
// subscriberPublicKey and authSecret are the subscription's p256dh and auth
// values, decoded from base64url. The returned bytes are the complete
// aes128gcm message body (header followed by the single encrypted record);
// send it with "Content-Encoding: aes128gcm".
func Encrypt(plaintext, subscriberPublicKey, authSecret []byte) ([]byte, error) {
	if len(plaintext) > MaxPlaintextBytes {
		return nil, errors.New("push plaintext exceeds the single aes128gcm record")
	}
	if len(authSecret) != authSecretSize {
		return nil, errors.New("push subscription auth secret must be 16 bytes")
	}
	curve := ecdh.P256()
	localPrivate, err := curve.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return nil, err
	}
	return encrypt(plaintext, subscriberPublicKey, authSecret, localPrivate, salt)
}

// encrypt is the deterministic core of Encrypt: given the application server's
// ephemeral ECDH key and salt, it performs the exact derivation and sealing
// sequence in RFC 8291 Section 3.4 / RFC 8188. It is exercised directly by
// tests against the RFC 8291 Appendix A vector, and by Encrypt with random
// inputs in production.
func encrypt(plaintext, subscriberPublicKey, authSecret []byte, localPrivate *ecdh.PrivateKey, salt []byte) ([]byte, error) {
	if len(subscriberPublicKey) != uncompressedP256PointSize || subscriberPublicKey[0] != 0x04 {
		return nil, errors.New("push subscription public key must be an uncompressed P-256 point")
	}
	if len(salt) != 16 {
		return nil, errors.New("push message salt must be 16 bytes")
	}
	curve := ecdh.P256()
	remotePublic, err := curve.NewPublicKey(subscriberPublicKey)
	if err != nil {
		return nil, errors.New("push subscription public key is not a valid P-256 point")
	}
	ecdhSecret, err := localPrivate.ECDH(remotePublic)
	if err != nil {
		return nil, err
	}
	localPublic := localPrivate.PublicKey().Bytes()

	// PRK_key = HKDF-Extract(salt=auth_secret, IKM=ecdh_secret)
	prkKey, err := hkdf.Extract(sha256.New, ecdhSecret, authSecret)
	if err != nil {
		return nil, err
	}
	// key_info = "WebPush: info" || 0x00 || ua_public || as_public
	keyInfo := make([]byte, 0, len(webPushInfoPrefix)+len(subscriberPublicKey)+len(localPublic))
	keyInfo = append(keyInfo, webPushInfoPrefix...)
	keyInfo = append(keyInfo, subscriberPublicKey...)
	keyInfo = append(keyInfo, localPublic...)
	// IKM = HKDF-Expand(PRK_key, key_info, L=32)
	ikm, err := hkdf.Expand(sha256.New, prkKey, string(keyInfo), sha256.Size)
	if err != nil {
		return nil, err
	}

	// RFC 8188 key derivation.
	prk, err := hkdf.Extract(sha256.New, ikm, salt)
	if err != nil {
		return nil, err
	}
	cek, err := hkdf.Expand(sha256.New, prk, "Content-Encoding: aes128gcm\x00", 16)
	if err != nil {
		return nil, err
	}
	nonce, err := hkdf.Expand(sha256.New, prk, "Content-Encoding: nonce\x00", 12)
	if err != nil {
		return nil, err
	}

	block, err := aes.NewCipher(cek)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	padded := make([]byte, 0, len(plaintext)+1)
	padded = append(padded, plaintext...)
	padded = append(padded, 0x02)
	ciphertext := gcm.Seal(nil, nonce, padded, nil)

	header := make([]byte, 0, headerSize)
	header = append(header, salt...)
	recordSize := make([]byte, 4)
	binary.BigEndian.PutUint32(recordSize, RecordSize)
	header = append(header, recordSize...)
	header = append(header, byte(len(localPublic)))
	header = append(header, localPublic...)

	return append(header, ciphertext...), nil
}
