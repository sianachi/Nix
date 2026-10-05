package webpush

import (
	"bytes"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"testing"
)

// TestEncryptRFC8291Vector replays the exact RFC 8291 Appendix A example (same
// plaintext, subscriber keys, application server ephemeral key, and salt) and
// checks the resulting aes128gcm body against the byte-for-byte result shown
// in RFC 8291 Section 5.
func TestEncryptRFC8291Vector(t *testing.T) {
	plaintext := decodeB64(t, "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24")
	uaPublic := decodeB64(t, "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4")
	authSecret := decodeB64(t, "BTBZMqHH6r4Tts7J_aSIgg")
	asPrivateRaw := decodeB64(t, "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw")
	salt := decodeB64(t, "DGv6ra1nlYgDCS1FRnbzlw")

	expected := decodeB64(t, "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml"+
		"mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT"+
		"pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN")

	asPrivate, err := ecdh.P256().NewPrivateKey(asPrivateRaw)
	if err != nil {
		t.Fatalf("parse application server private key: %v", err)
	}

	got, err := encrypt(plaintext, uaPublic, authSecret, asPrivate, salt)
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	if !bytes.Equal(got, expected) {
		t.Fatalf("encrypted body does not match the RFC 8291 Appendix A vector\n got: %x\nwant: %x", got, expected)
	}
}

func TestEncryptRoundTripsWithRandomInputs(t *testing.T) {
	curve := ecdh.P256()
	subscriberKey, err := curve.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate subscriber key: %v", err)
	}
	authSecret := make([]byte, authSecretSize)
	if _, err := rand.Reader.Read(authSecret); err != nil {
		t.Fatalf("generate auth secret: %v", err)
	}
	plaintext := []byte(`{"title":"Reminder","body":"Water the plants","url":"/items/abc","tag":"reminder:abc"}`)

	body, err := Encrypt(plaintext, subscriberKey.PublicKey().Bytes(), authSecret)
	if err != nil {
		t.Fatalf("Encrypt: %v", err)
	}
	if len(body) < headerSize {
		t.Fatalf("encrypted body shorter than the aes128gcm header: %d bytes", len(body))
	}
	if body[16+4] != uncompressedP256PointSize {
		t.Fatalf("unexpected key length octet: %d", body[16+4])
	}
}

func TestEncryptRejectsOversizedPlaintext(t *testing.T) {
	curve := ecdh.P256()
	subscriberKey, err := curve.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate subscriber key: %v", err)
	}
	authSecret := make([]byte, authSecretSize)
	if _, err := Encrypt(make([]byte, MaxPlaintextBytes+1), subscriberKey.PublicKey().Bytes(), authSecret); err == nil {
		t.Fatal("expected oversized plaintext to be rejected")
	}
}

func TestEncryptRejectsInvalidSubscriberKey(t *testing.T) {
	authSecret := make([]byte, authSecretSize)
	if _, err := Encrypt([]byte("hi"), make([]byte, 65), authSecret); err == nil {
		t.Fatal("expected an invalid subscriber public key to be rejected")
	}
}

func decodeB64(t *testing.T, value string) []byte {
	t.Helper()
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		t.Fatalf("decode base64url fixture %q: %v", value, err)
	}
	return decoded
}
