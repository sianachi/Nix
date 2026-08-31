package objecttransfer

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestDownloadBoundsAndVerifiesContent(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(response, "content")
	}))
	defer server.Close()
	download, err := New(time.Second).Download(context.Background(), server.URL, 7)
	if err != nil {
		t.Fatal(err)
	}
	_, err = io.ReadAll(download.Body)
	_ = download.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	expected := sha256.Sum256([]byte("content"))
	if err := VerifyDigest(download.Digest, hex.EncodeToString(expected[:])); err != nil {
		t.Fatal(err)
	}
}

func TestDownloadRefusesOversizeAndRedirects(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(response, "secret") }))
	defer target.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		http.Redirect(response, request, target.URL, http.StatusFound)
	}))
	defer redirect.Close()
	if _, err := New(time.Second).Download(context.Background(), redirect.URL, 10); err == nil {
		t.Fatal("redirect was followed")
	}
	download, err := New(time.Second).Download(context.Background(), target.URL, 3)
	if err == nil {
		if _, err := io.ReadAll(download.Body); err == nil {
			t.Fatal("oversize source was accepted")
		}
	}
}

func TestUploadUsesKnownLengthAndChecksum(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.ContentLength != 4 || request.Header.Get("X-Nix-Content-SHA256") != "abcd" {
			t.Errorf("length = %d, checksum = %q", request.ContentLength, request.Header.Get("X-Nix-Content-SHA256"))
		}
		body, _ := io.ReadAll(request.Body)
		if string(body) != "body" {
			t.Errorf("body = %q", body)
		}
		response.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	if err := New(time.Second).Upload(context.Background(), server.URL, "text/plain", strings.NewReader("body"), 4, "ABCD"); err != nil {
		t.Fatal(err)
	}
}
