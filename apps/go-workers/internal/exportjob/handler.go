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
	"time"
	"unicode/utf8"

	"github.com/sianachi/Nix/apps/go-workers/internal/exporter"
	"github.com/sianachi/Nix/apps/go-workers/internal/jobrunner"
	"github.com/sianachi/Nix/apps/go-workers/internal/nixarchive"
	"github.com/sianachi/Nix/apps/go-workers/internal/objecttransfer"
	"github.com/sianachi/Nix/apps/go-workers/internal/stream"
	"github.com/sianachi/Nix/apps/go-workers/internal/workerapi"
	"github.com/sianachi/Nix/apps/go-workers/internal/worktemp"
)

var Kinds = []string{"export.nix", "export.markdown", "export.docx", "export.pdf"}

var errExistingResultMismatch = errors.New("existing export result does not match this execution")

const (
	maximumResultReportEntries = 16
	maximumResultReportBytes   = 500
)

type Payload struct {
	ItemID       string   `json:"itemId"`
	WorkspaceID  string   `json:"workspaceId"`
	Format       string   `json:"format"`
	Scope        string   `json:"scope"`
	Title        string   `json:"title"`
	Extension    string   `json:"extension"`
	MediaType    string   `json:"mediaType"`
	DeclaredLoss []string `json:"declaredLoss"`
}

type Result struct {
	AttemptID    string   `json:"attemptId"`
	Format       string   `json:"format"`
	ObjectKey    string   `json:"objectKey"`
	ItemCount    int      `json:"itemCount"`
	OmittedCount int      `json:"omittedCount"`
	ByteLength   int64    `json:"byteLength"`
	SHA256       string   `json:"sha256"`
	Loss         []string `json:"loss"`
	Omissions    []string `json:"omissions"`
}

type Handler struct {
	api         *workerapi.Client
	source      *objecttransfer.Client
	destination *objecttransfer.Client
	secret      string
	limits      stream.Limits
}

func New(api *workerapi.Client, source, destination *objecttransfer.Client, internalSecret string, limits stream.Limits) *Handler {
	return &Handler{api: api, source: source, destination: destination, secret: internalSecret, limits: limits}
}

func (handler *Handler) Handle(ctx context.Context, job workerapi.Job) (any, error) {
	var payload Payload
	decoder := json.NewDecoder(strings.NewReader(string(job.Payload)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil || !validPayload(payload) {
		return nil, failure("export_payload_invalid", errors.New("the durable export request is invalid"))
	}
	format := payload.Format
	if job.Kind != "export."+format {
		return nil, failure("export_kind_mismatch", errors.New("job kind does not match export format"))
	}
	if handler.api == nil || handler.source == nil || handler.destination == nil || strings.TrimSpace(handler.secret) == "" {
		return nil, failure("export_configuration_invalid", errors.New("the exporter is not configured"))
	}
	executionJobID, _, executionBound := workerapi.Execution(ctx)
	if !executionBound || executionJobID != job.ID {
		return nil, failure("export_execution_invalid", errors.New("the exporter is not bound to the claimed execution"))
	}
	source, err := handler.api.GetExportSource(ctx, job.ID)
	if err != nil {
		return nil, transient("export_source_unavailable", err)
	}
	if source.ExportID != job.ID || source.Format != format || source.SourceURL == "" || source.BearerToken == "" || !source.DelegationExpires.After(time.Now()) {
		return nil, failure("export_source_invalid", errors.New("the source capability does not match the export job"))
	}
	download, err := handler.source.DownloadAuthorized(ctx, source.SourceURL, handler.limits.MaxBytes, source.BearerToken, handler.secret)
	if err != nil {
		return nil, transient("export_source_unavailable", err)
	}
	input, readErr := nixarchive.OpenBundleStream(download.Body, handler.limits)
	if readErr != nil {
		_ = download.Body.Close()
		return nil, failure("export_bundle_invalid", readErr)
	}
	file, err := worktemp.Create("nix-export-*")
	if err != nil {
		_ = download.Body.Close()
		return nil, failure("export_write_failed", err)
	}
	path := file.Name()
	defer func() { _ = os.Remove(path) }()
	digest := sha256.New()
	var writeErr error
	projectionLoss := make([]string, 0)
	if format == "nix" {
		writeErr = nixarchive.WriteStream(
			io.MultiWriter(file, digest),
			input.Manifest,
			cancellableBundles(ctx, input),
			handler.limits.MaxBytes)
	} else {
		writeErr = exporter.WriteStreamWithReport(
			format,
			recordSource(ctx, input, format, handler.limits.MaxLine, &projectionLoss),
			io.MultiWriter(file, digest),
			handler.limits,
			func() []string {
				messages := append([]string(nil), payload.DeclaredLoss...)
				for _, message := range lossMessages(format, input.Manifest, projectionLoss) {
					appendUnique(&messages, message)
				}
				return append(messages, omissionMessages(input.Manifest)...)
			})
	}
	closeSourceErr := download.Body.Close()
	closeErr := file.Close()
	var sourceErr *bundleStreamError
	if errors.As(writeErr, &sourceErr) {
		return nil, failure("export_bundle_invalid", sourceErr.err)
	}
	if writeErr != nil {
		return nil, failure("export_write_failed", writeErr)
	}
	if closeSourceErr != nil {
		return nil, transient("export_source_unavailable", closeSourceErr)
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
	destination, err := handler.api.GetExportDestination(ctx, job.ID, stat.Size(), checksum)
	if err != nil {
		return nil, transient("export_destination_unavailable", err)
	}
	if destination.ExportID != job.ID || !validGUID(destination.AttemptID) || destination.Format != format || destination.ObjectKey == "" || destination.UploadURL == "" || destination.ReadURL == "" || destination.DeleteURL == "" || !destination.CapabilityExpires.After(time.Now()) {
		return nil, failure("export_destination_invalid", errors.New("the destination capability does not match the export job"))
	}
	if err := handler.destination.UploadCreateOnlyVerified(ctx, destination.UploadURL, contentType(format), output, stat.Size(), checksum); err != nil {
		if errors.Is(err, objecttransfer.ErrAlreadyExists) {
			verifyErr := handler.verifyExisting(ctx, destination.ReadURL, stat.Size(), checksum)
			if verifyErr == nil {
				return handler.result(destination.AttemptID, format, destination.ObjectKey, input.Manifest, projectionLoss, stat.Size(), checksum), nil
			}
			if errors.Is(verifyErr, errExistingResultMismatch) {
				return nil, failure("export_result_conflict", verifyErr)
			}
			return nil, transient("export_result_verification_unavailable", verifyErr)
		}
		handler.deleteBestEffort(ctx, destination.DeleteURL)
		return nil, transient("export_upload_failed", err)
	}
	return handler.result(destination.AttemptID, format, destination.ObjectKey, input.Manifest, projectionLoss, stat.Size(), checksum), nil
}

func (handler *Handler) verifyExisting(ctx context.Context, readURL string, size int64, expectedSHA256 string) error {
	download, err := handler.destination.Download(ctx, readURL, size)
	if err != nil {
		return err
	}
	read, copyErr := io.Copy(io.Discard, download.Body)
	closeErr := download.Body.Close()
	if copyErr != nil {
		return copyErr
	}
	if closeErr != nil {
		return closeErr
	}
	if read != size {
		return errExistingResultMismatch
	}
	if err := objecttransfer.VerifyDigest(download.Digest, expectedSHA256); err != nil {
		return errors.Join(errExistingResultMismatch, err)
	}
	return nil
}

func (handler *Handler) deleteBestEffort(ctx context.Context, deleteURL string) {
	cleanupContext, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	_ = handler.destination.Delete(cleanupContext, deleteURL)
}

func (handler *Handler) result(attemptID, format, objectKey string, manifest nixarchive.Manifest, projectionLoss []string, byteLength int64, checksum string) Result {
	return Result{
		AttemptID:    attemptID,
		Format:       format,
		ObjectKey:    objectKey,
		ItemCount:    len(manifest.Items),
		OmittedCount: len(manifest.Omitted),
		ByteLength:   byteLength,
		SHA256:       checksum,
		Loss:         lossMessages(format, manifest, projectionLoss),
		Omissions:    omissionMessages(manifest),
	}
}

func validGUID(value string) bool {
	if len(value) != 36 {
		return false
	}
	for index, character := range value {
		if index == 8 || index == 13 || index == 18 || index == 23 {
			if character != '-' {
				return false
			}
			continue
		}
		if !(character >= '0' && character <= '9' || character >= 'a' && character <= 'f') {
			return false
		}
	}
	return true
}

type bundleStreamError struct{ err error }

func (err *bundleStreamError) Error() string { return err.err.Error() }
func (err *bundleStreamError) Unwrap() error { return err.err }

func cancellableBundles(ctx context.Context, input *nixarchive.BundleStream) func() (nixarchive.Bundle, bool, error) {
	return func() (nixarchive.Bundle, bool, error) {
		if err := ctx.Err(); err != nil {
			return nixarchive.Bundle{}, false, err
		}
		return input.Next()
	}
}

func recordSource(ctx context.Context, input *nixarchive.BundleStream, format string, maximumBodyBytes int, losses *[]string) exporter.RecordSource {
	return func() (stream.Record, bool, error) {
		if err := ctx.Err(); err != nil {
			return stream.Record{}, false, err
		}
		bundle, ok, err := input.Next()
		if err != nil {
			return stream.Record{}, false, &bundleStreamError{err: err}
		}
		if !ok {
			return stream.Record{}, false, nil
		}
		body, observed, err := exporter.ProjectBody(bundle.Body, true, maximumBodyBytes)
		if err != nil {
			return stream.Record{}, false, err
		}
		for _, loss := range observed {
			appendUnique(losses, loss)
		}
		if format != "markdown" && strings.Contains(body, "![") {
			appendUnique(losses, "Images are linked or described rather than embedded in the converted document.")
		}
		if format != "markdown" && strings.Contains(body, "<details") {
			appendUnique(losses, "Collapsible sections were expanded into always-visible document content.")
		}
		if _, titleLoss := exporter.ProjectTitle(bundle.Title, format == "markdown"); titleLoss {
			appendUnique(losses, "Title control characters or line breaks were removed in the converted document.")
		}
		if format == "pdf" && (exporter.PDFTextRequiresSubstitution(bundle.Title) || exporter.PDFTextRequiresSubstitution(body)) {
			appendUnique(losses, "Characters outside printable ASCII were replaced in the PDF output.")
		}
		return stream.Record{
			ID: bundle.ID, ParentID: pointerValue(bundle.ParentID), Title: bundle.Title,
			Body: body, Properties: bundle.Properties,
		}, true, nil
	}
}

func appendUnique(values *[]string, value string) {
	for _, existing := range *values {
		if existing == value {
			return
		}
	}
	*values = append(*values, value)
}

func validPayload(payload Payload) bool {
	if payload.ItemID == "" || payload.WorkspaceID == "" || payload.Scope != "item" && payload.Scope != "subtree" || len(payload.Title) > 500 || len(payload.DeclaredLoss) > 32 {
		return false
	}
	extension, mediaType := "", contentType(payload.Format)
	switch payload.Format {
	case "nix":
		extension = "nix"
	case "markdown":
		extension = "md"
	case "docx":
		extension = "docx"
	case "pdf":
		extension = "pdf"
	default:
		return false
	}
	if payload.Extension != extension || payload.MediaType != mediaType {
		return false
	}
	for _, entry := range payload.DeclaredLoss {
		if strings.TrimSpace(entry) == "" || len(entry) > 500 || strings.ContainsAny(entry, "\r\n") {
			return false
		}
	}
	return true
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

func lossMessages(format string, manifest nixarchive.Manifest, projectionLoss []string) []string {
	result := make([]string, 0, len(manifest.Loss)+len(projectionLoss)+1)
	for _, entry := range manifest.Loss {
		appendUnique(&result, reportEntry(entry.Kind, entry.Detail))
	}
	for _, entry := range projectionLoss {
		appendUnique(&result, entry)
	}
	switch format {
	case "markdown":
		appendUnique(&result, "Workspace hierarchy metadata, properties, views, and lifecycle metadata are not represented in Markdown.")
	case "docx", "pdf":
		appendUnique(&result, "Workspace hierarchy metadata, properties, views, and lifecycle metadata are not represented in the converted document.")
	}
	return boundedReport(result, "loss entries")
}

func omissionMessages(manifest nixarchive.Manifest) []string {
	result := make([]string, 0, len(manifest.Omitted))
	for _, entry := range manifest.Omitted {
		result = append(result, reportEntry(entry.Reason, entry.Detail))
	}
	return boundedReport(result, "omissions")
}

func reportEntry(kind, detail string) string {
	return truncateUTF8(strings.TrimSpace(kind)+": "+strings.TrimSpace(detail), maximumResultReportBytes)
}

func boundedReport(entries []string, name string) []string {
	if len(entries) <= maximumResultReportEntries {
		return entries
	}
	result := append([]string(nil), entries[:maximumResultReportEntries-1]...)
	result = append(result, fmt.Sprintf(
		"%d additional %s were omitted from this bounded status summary.",
		len(entries)-len(result),
		name))
	return result
}

func truncateUTF8(value string, maximum int) string {
	if len(value) <= maximum {
		return value
	}
	end := maximum
	for end > 0 && !utf8.RuneStart(value[end]) {
		end--
	}
	return strings.TrimSpace(value[:end])
}

func failure(code string, err error) error {
	return &jobrunner.JobError{Code: code, Detail: fmt.Sprintf("%s", err), Cause: err}
}

func transient(code string, err error) error {
	return &jobrunner.JobError{Code: code, Detail: fmt.Sprintf("%s", err), Cause: err, Retryable: true}
}
