package exportjob

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/sianachi/Nix/apps/go-workers/internal/exporter"
	"github.com/sianachi/Nix/apps/go-workers/internal/jobrunner"
	"github.com/sianachi/Nix/apps/go-workers/internal/nixarchive"
	"github.com/sianachi/Nix/apps/go-workers/internal/objecttransfer"
	"github.com/sianachi/Nix/apps/go-workers/internal/stream"
	"github.com/sianachi/Nix/apps/go-workers/internal/workerapi"
)

var Kinds = []string{"export.nix", "export.markdown", "export.docx", "export.pdf"}

type Payload struct {
	SourceURL      string `json:"sourceUrl"`
	DestinationURL string `json:"destinationUrl"`
	ExpectedSHA256 string `json:"expectedSha256,omitempty"`
	Format         string `json:"format"`
}

type Result struct {
	Items        int      `json:"items"`
	OutputBytes  int64    `json:"outputBytes"`
	OutputSHA256 string   `json:"outputSha256"`
	Loss         []string `json:"loss"`
}

type Handler struct {
	transfer *objecttransfer.Client
	limits   stream.Limits
}

func New(transfer *objecttransfer.Client, limits stream.Limits) *Handler {
	return &Handler{transfer: transfer, limits: limits}
}

func (handler *Handler) Handle(ctx context.Context, job workerapi.Job) (any, error) {
	var payload Payload
	decoder := json.NewDecoder(strings.NewReader(string(job.Payload)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil || payload.SourceURL == "" || payload.DestinationURL == "" || payload.Format == "" {
		return nil, failure("export_payload_invalid", errors.New("sourceUrl, destinationUrl, and format are required"))
	}
	format := strings.ToLower(payload.Format)
	if format == "md" {
		format = "markdown"
	}
	if job.Kind != "export."+format {
		return nil, failure("export_kind_mismatch", errors.New("job kind does not match export format"))
	}
	download, err := handler.transfer.Download(ctx, payload.SourceURL, handler.limits.MaxBytes)
	if err != nil {
		return nil, transient("export_source_unavailable", err)
	}
	manifest, bundles, readErr := nixarchive.ReadBundleStream(download.Body, handler.limits)
	closeErr := download.Body.Close()
	if readErr != nil {
		return nil, failure("export_bundle_invalid", readErr)
	}
	if closeErr != nil {
		return nil, transient("export_source_unavailable", closeErr)
	}
	if err := objecttransfer.VerifyDigest(download.Digest, payload.ExpectedSHA256); err != nil {
		return nil, failure("export_checksum_mismatch", err)
	}
	file, err := os.CreateTemp("", "nix-export-*")
	if err != nil {
		return nil, failure("export_write_failed", err)
	}
	path := file.Name()
	defer func() { _ = os.Remove(path) }()
	digest := sha256.New()
	var writeErr error
	if format == "nix" {
		writeErr = nixarchive.Write(io.MultiWriter(file, digest), manifest, bundles, handler.limits.MaxBytes)
	} else {
		writeErr = exporter.Write(format, recordsOf(bundles), io.MultiWriter(file, digest), handler.limits)
	}
	closeErr = file.Close()
	if writeErr != nil {
		return nil, failure("export_write_failed", writeErr)
	}
	if closeErr != nil {
		return nil, failure("export_write_failed", closeErr)
	}
	stat, err := os.Stat(path)
	if err != nil {
		return nil, failure("export_write_failed", err)
	}
	checksum := hex.EncodeToString(digest.Sum(nil))
	output, err := os.Open(path)
	if err != nil {
		return nil, failure("export_write_failed", err)
	}
	defer output.Close()
	if err := handler.transfer.Upload(ctx, payload.DestinationURL, contentType(format), output, stat.Size(), checksum); err != nil {
		return nil, transient("export_upload_failed", err)
	}
	return Result{Items: len(bundles), OutputBytes: stat.Size(), OutputSHA256: checksum, Loss: losses(format)}, nil
}

func recordsOf(bundles []nixarchive.Bundle) []stream.Record {
	records := make([]stream.Record, 0, len(bundles))
	for _, bundle := range bundles {
		records = append(records, stream.Record{ID: bundle.ID, ParentID: pointerValue(bundle.ParentID), Title: bundle.Title, Body: string(bundle.Body), Properties: bundle.Properties})
	}
	return records
}

func pointerValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func contentType(format string) string {
	switch format {
	case "markdown":
		return "text/markdown; charset=utf-8"
	case "docx":
		return "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
	case "pdf":
		return "application/pdf"
	default:
		return "application/vnd.nix.archive+zip"
	}
}

func losses(format string) []string {
	switch format {
	case "nix":
		return []string{}
	case "markdown":
		return []string{"Hierarchy, properties, views, links, and lifecycle metadata are not represented in Markdown."}
	case "docx", "pdf":
		return []string{"Hierarchy, properties, views, links, lifecycle metadata, and rich body structure are flattened to text."}
	default:
		return []string{}
	}
}

func failure(code string, err error) error {
	return &jobrunner.JobError{Code: code, Detail: fmt.Sprintf("%s", err), Cause: err}
}

func transient(code string, err error) error {
	return &jobrunner.JobError{Code: code, Detail: fmt.Sprintf("%s", err), Cause: err, Retryable: true}
}
