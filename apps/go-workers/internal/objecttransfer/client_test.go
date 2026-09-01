package objecttransfer

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
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

func TestOversizedDownloadNeverReturnsTheBytePastTheBound(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Length", "-1")
		_, _ = io.WriteString(response, "12345")
	}))
	defer server.Close()

	download, err := New(time.Second, server.URL).Download(context.Background(), server.URL, 4)
	if err != nil {
		t.Fatal(err)
	}
	defer download.Body.Close()
	body, err := io.ReadAll(download.Body)
	if !errors.Is(err, ErrTooLarge) || string(body) != "1234" {
		t.Fatalf("body = %q, error = %v", body, err)
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

func TestCapabilitiesArePinnedToConfiguredOrigins(t *testing.T) {
	client := New(time.Second, "https://objects.example.test:9443")
	if _, err := client.Download(context.Background(), "https://other.example.test/object", 10); err == nil || !strings.Contains(err.Error(), "origin") {
		t.Fatalf("unexpected refusal: %v", err)
	}
	if _, err := New(time.Second).Download(context.Background(), "https://objects.example.test/object", 10); err == nil || !strings.Contains(err.Error(), "origin") {
		t.Fatalf("empty policy accepted a non-loopback origin: %v", err)
	}
}

func TestCreateOnlyUploadSendsTheImmutablePrecondition(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("If-None-Match") != "*" {
			t.Errorf("If-None-Match = %q", request.Header.Get("If-None-Match"))
		}
		response.WriteHeader(http.StatusPreconditionFailed)
	}))
	defer server.Close()

	err := New(time.Second).UploadCreateOnly(context.Background(), server.URL, "application/octet-stream", strings.NewReader("body"), 4, "")
	if !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("UploadCreateOnly() error = %v", err)
	}
}

func TestAuthorizedDownloadSendsProofsOnlyToThePinnedOrigin(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer delegated" || request.Header.Get("X-Nix-Internal-Secret") != "secret" {
			t.Fatalf("proof headers = %#v", request.Header)
		}
		_, _ = io.WriteString(response, "bundle")
	}))
	defer server.Close()
	download, err := New(time.Second, server.URL).DownloadAuthorized(context.Background(), server.URL, 64, "delegated", "secret")
	if err != nil {
		t.Fatal(err)
	}
	defer download.Body.Close()
	if _, err := io.ReadAll(download.Body); err != nil {
		t.Fatal(err)
	}
}

func TestStreamingTransferUsesIdleTimeoutInsteadOfWholeRequestDeadline(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		flusher := response.(http.Flusher)
		for range 6 {
			_, _ = io.WriteString(response, "part")
			flusher.Flush()
			time.Sleep(20 * time.Millisecond)
		}
	}))
	defer server.Close()

	download, err := New(50*time.Millisecond, server.URL).Download(context.Background(), server.URL, 64)
	if err != nil {
		t.Fatal(err)
	}
	defer download.Body.Close()
	body, err := io.ReadAll(download.Body)
	if err != nil || string(body) != strings.Repeat("part", 6) {
		t.Fatalf("body = %q, error = %v", body, err)
	}
}

func TestTransferErrorsDoNotExposeCapabilityQueries(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	url := server.URL + "/object?X-Amz-Signature=super-secret"
	server.Close()

	_, err := New(100*time.Millisecond, server.URL).Download(context.Background(), url, 64)
	if err == nil || strings.Contains(err.Error(), "super-secret") || strings.Contains(err.Error(), "X-Amz") {
		t.Fatalf("error was not redacted: %v", err)
	}
}

func TestVerifiedImmutableUploadSendsTheStorageChecksum(t *testing.T) {
	digest := sha256.Sum256([]byte("body"))
	hexDigest := hex.EncodeToString(digest[:])
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("X-Amz-Checksum-Sha256") != "Iw2DWNyOiJC0xY3utikS7i8gNXrpKlzIYbmOaP4xrLU=" {
			t.Errorf("storage checksum = %q", request.Header.Get("X-Amz-Checksum-Sha256"))
		}
		response.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	if err := New(time.Second, server.URL).UploadCreateOnlyVerified(
		context.Background(),
		server.URL,
		"application/octet-stream",
		strings.NewReader("body"),
		4,
		hexDigest); err != nil {
		t.Fatal(err)
	}
}
