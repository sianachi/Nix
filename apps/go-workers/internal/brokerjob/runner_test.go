package brokerjob

import (
	"errors"
	"strings"
	"testing"

	"github.com/sianachi/Nix/apps/go-workers/internal/jobrunner"
)

func TestResultMessagePreservesRetryClassification(t *testing.T) {
	message := resultMessage("job", "execution", nil, &jobrunner.JobError{Code: "object_unavailable", Detail: "try later", Retryable: true}, false, nil)
	if message.Succeeded || !message.Retryable || message.ErrorCode == nil || *message.ErrorCode != "object_unavailable" {
		t.Fatalf("unexpected result: %#v", message)
	}
}

func TestResultMessageClassifiesCancellation(t *testing.T) {
	message := resultMessage(
		"job",
		"execution",
		nil,
		&jobrunner.JobError{Code: "export_upload_failed", Detail: "interrupted", Retryable: true, Cause: errors.New("interrupted")},
		true,
		nil)
	if message.ErrorCode == nil || *message.ErrorCode != "job_cancelled" || message.Retryable {
		t.Fatalf("unexpected result: %#v", message)
	}
}

func TestExecutionIdentityStaysInsideTheApiBound(t *testing.T) {
	id, err := executionID(strings.Repeat("w", 200))
	if err != nil {
		t.Fatal(err)
	}
	if len(id) > 128 {
		t.Fatalf("execution identity is too long: %d", len(id))
	}
}
