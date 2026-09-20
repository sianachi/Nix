package importplan

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"path"
	"regexp"
	"strconv"
	"strings"

	"github.com/sianachi/Nix/apps/go-workers/internal/fileinspect"
	"github.com/sianachi/Nix/apps/go-workers/internal/nixarchive"
)

type assetInspection struct {
	File
	Path string
}

var nixFileEntryPattern = regexp.MustCompile(`(?i)^files/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/([1-9][0-9]{0,2})\.bin$`)

func openArchive(source Source, limits Limits) (*zip.ReadCloser, error) {
	return openArchiveWithNixFileBounds(source, limits, false)
}

// openNixArchive applies the bounded v2 file-entry extension only while parsing a Nix archive.
// DOCX and other ZIP importers retain their historical entry count and per-entry limits.
func openNixArchive(source Source, limits Limits) (*zip.ReadCloser, error) {
	return openArchiveWithNixFileBounds(source, limits, true)
}

func openArchiveWithNixFileBounds(source Source, limits Limits, allowNixFileVersions bool) (*zip.ReadCloser, error) {
	archive, err := zip.OpenReader(source.Path)
	if err != nil {
		return nil, err
	}
	maxEntries := limits.MaxItems + 100
	if allowNixFileVersions {
		maxEntries = nixarchive.MaxArchiveEntries
		if limits.MaxItems <= nixarchive.MaxTemplateArchiveItems {
			maxEntries = nixarchive.MaxTemplateArchiveEntries
		}
	}
	if len(archive.File) > maxEntries {
		_ = archive.Close()
		return nil, errors.New("archive contains too many entries")
	}
	var expanded uint64
	names := make(map[string]struct{}, len(archive.File))
	for _, entry := range archive.File {
		clean := path.Clean(entry.Name)
		if clean == "." || clean != entry.Name || strings.HasPrefix(clean, "../") || strings.HasPrefix(entry.Name, "/") || strings.Contains(entry.Name, "\\") || entry.Flags&0x1 != 0 {
			_ = archive.Close()
			return nil, errors.New("archive contains an unsafe or encrypted entry")
		}
		if _, duplicate := names[entry.Name]; duplicate {
			_ = archive.Close()
			return nil, errors.New("archive contains duplicate entries")
		}
		names[entry.Name] = struct{}{}
		if entry.UncompressedSize64 > max(1, entry.CompressedSize64)*100 {
			_ = archive.Close()
			return nil, errors.New("archive entry exceeds the allowed compression ratio")
		}
		expanded += entry.UncompressedSize64
		maxEntryBytes := uint64(limits.MaxEntryBytes)
		if allowNixFileVersions && isNixFileVersionPath(entry.Name) {
			maxEntryBytes = min(uint64(limits.MaxSourceBytes), uint64(100<<20))
		}
		if expanded > uint64(limits.MaxSourceBytes) || entry.UncompressedSize64 > maxEntryBytes {
			_ = archive.Close()
			return nil, errors.New("archive expands beyond the configured limits")
		}
	}
	return archive, nil
}

func isNixFileVersionPath(name string) bool {
	match := nixFileEntryPattern.FindStringSubmatch(name)
	if len(match) != 2 {
		return false
	}
	version, err := strconv.Atoi(match[1])
	return err == nil && version <= 100
}

func findEntry(archive *zip.ReadCloser, name string) *zip.File {
	for _, entry := range archive.File {
		if entry.Name == name {
			return entry
		}
	}
	return nil
}

func readEntry(archive *zip.ReadCloser, name string, maxBytes int64) ([]byte, error) {
	entry := findEntry(archive, name)
	if entry == nil {
		return nil, errors.New("required archive entry is missing")
	}
	if entry.UncompressedSize64 > uint64(maxBytes) {
		return nil, errors.New("archive entry exceeds the configured byte limit")
	}
	reader, err := entry.Open()
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	return readBounded(reader, maxBytes)
}

func inspectAsset(entry *zip.File, fileName string) (assetInspection, error) {
	reader, err := entry.Open()
	if err != nil {
		return assetInspection{}, err
	}
	defer reader.Close()
	header := make([]byte, fileinspect.HeaderLimit())
	count, readErr := io.ReadFull(reader, header)
	if readErr != nil && !errors.Is(readErr, io.ErrUnexpectedEOF) && !errors.Is(readErr, io.EOF) {
		return assetInspection{}, readErr
	}
	header = header[:count]
	digest := sha256.New()
	_, _ = digest.Write(header)
	if _, err := io.Copy(digest, reader); err != nil {
		return assetInspection{}, err
	}
	metadata := fileinspect.InspectHeader(header, int64(entry.UncompressedSize64))
	if metadata.Malformed || !strings.HasPrefix(metadata.MediaType, "image/") {
		return assetInspection{}, errors.New("embedded media is not a supported image")
	}
	assetPath := entry.Name
	return assetInspection{
		Path: assetPath,
		File: File{
			SourceKind: "asset", AssetPath: &assetPath, FileName: fileName,
			MediaType: metadata.MediaType, ByteLength: int64(entry.UncompressedSize64),
			SHA256: hex.EncodeToString(digest.Sum(nil)), Previewable: metadata.Preview,
			PixelWidth: metadata.Width, PixelHeight: metadata.Height,
		},
	}, nil
}

type AssetReader struct {
	Body    io.ReadCloser
	Size    int64
	archive *zip.ReadCloser
}

func (reader *AssetReader) Close() error {
	bodyErr := reader.Body.Close()
	archiveErr := reader.archive.Close()
	if bodyErr != nil {
		return bodyErr
	}
	return archiveErr
}

func OpenAsset(source Source, assetPath string, limits Limits) (*AssetReader, error) {
	archive, err := openArchive(source, limits)
	if err != nil {
		return nil, err
	}
	entry := findEntry(archive, assetPath)
	if entry == nil || entry.UncompressedSize64 > uint64(limits.MaxEntryBytes) {
		_ = archive.Close()
		return nil, errors.New("planned import asset is missing or oversized")
	}
	body, err := entry.Open()
	if err != nil {
		_ = archive.Close()
		return nil, err
	}
	return &AssetReader{Body: body, Size: int64(entry.UncompressedSize64), archive: archive}, nil
}

func nixFileVersionEntryName(itemID string, version int) string {
	return fmt.Sprintf("files/%s/%d.bin", itemID, version)
}

// NixArchiveFiles keeps a validated Nix archive open while the template importer streams its
// declared file-version members directly into staged immutable objects.
type NixArchiveFiles struct {
	archive *zip.ReadCloser
	entries map[string]*zip.File
}

func OpenNixArchiveFiles(sourcePath string, limits Limits) (*NixArchiveFiles, error) {
	archive, err := openNixArchive(Source{Path: sourcePath}, limits)
	if err != nil {
		return nil, err
	}
	entries := make(map[string]*zip.File)
	for _, entry := range archive.File {
		if nixFileEntryPattern.MatchString(entry.Name) {
			entries[entry.Name] = entry
		}
	}
	return &NixArchiveFiles{archive: archive, entries: entries}, nil
}

func (files *NixArchiveFiles) OpenVersion(itemID string, version int, expectedLength int64) (io.ReadCloser, error) {
	if files == nil || files.archive == nil || !archiveIDPattern.MatchString(itemID) || version < 1 || version > nixarchive.MaxFileVersionsPerItem || expectedLength < 0 || expectedLength > nixarchive.MaxFileVersionBytes {
		return nil, errors.New("Nix archive file version request is invalid")
	}
	entry := files.entries[nixFileVersionEntryName(itemID, version)]
	if entry == nil || entry.UncompressedSize64 != uint64(expectedLength) {
		return nil, errors.New("Nix archive file version is missing or has a different declared length")
	}
	return entry.Open()
}

func (files *NixArchiveFiles) Close() error {
	if files == nil || files.archive == nil {
		return nil
	}
	return files.archive.Close()
}

func verifyNixFileVersion(ctx context.Context, entry *zip.File, descriptor nixarchive.FileVersionEntry) error {
	if entry.UncompressedSize64 != uint64(descriptor.ByteLength) {
		return errors.New("the byte length does not match its manifest descriptor")
	}
	reader, err := entry.Open()
	if err != nil {
		return err
	}
	defer reader.Close()
	header := make([]byte, fileinspect.HeaderLimit())
	read, readErr := io.ReadFull(reader, header)
	if readErr != nil && !errors.Is(readErr, io.ErrUnexpectedEOF) && !errors.Is(readErr, io.EOF) {
		return readErr
	}
	header = header[:read]
	digest := sha256.New()
	_, _ = digest.Write(header)
	buffer := make([]byte, 64*1024)
	var total int64 = int64(read)
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		count, readErr := reader.Read(buffer)
		if count > 0 {
			total += int64(count)
			if _, err := digest.Write(buffer[:count]); err != nil {
				return err
			}
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			return readErr
		}
	}
	if total != descriptor.ByteLength {
		return errors.New("the streamed byte length does not match its manifest descriptor")
	}
	if hex.EncodeToString(digest.Sum(nil)) != descriptor.SHA256 {
		return errors.New("the SHA-256 digest does not match its manifest descriptor")
	}
	inspected := fileinspect.InspectHeader(header, total)
	if inspected.Malformed || inspected.MediaType != descriptor.MediaType || inspected.Preview != descriptor.Previewable ||
		!sameOptionalInt(inspected.Width, descriptor.PixelWidth) || !sameOptionalInt(inspected.Height, descriptor.PixelHeight) {
		return errors.New("the inspected file metadata does not match its manifest descriptor")
	}
	return nil
}

func sameOptionalInt(left, right *int) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func hasJSONProperty(body []byte, name string) bool {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(body, &fields); err != nil {
		return false
	}
	_, ok := fields[name]
	return ok
}

func rejectsXMLDeclarations(body []byte) bool {
	upper := bytes.ToUpper(body)
	return bytes.Contains(upper, []byte("<!DOCTYPE")) || bytes.Contains(upper, []byte("<!ENTITY"))
}

func validateXML(body []byte, maxDepth, maxTokens int) error {
	if maxDepth <= 0 || maxTokens <= 0 || rejectsXMLDeclarations(body) {
		return errors.New("XML document types and entities are not supported")
	}
	decoder := xml.NewDecoder(bytes.NewReader(body))
	depth, tokens := 0, 0
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			if depth != 0 {
				return errors.New("XML element nesting is incomplete")
			}
			return nil
		}
		if err != nil {
			return fmt.Errorf("decode XML: %w", err)
		}
		tokens++
		if tokens > maxTokens {
			return errors.New("XML token count exceeds the configured limit")
		}
		switch value := token.(type) {
		case xml.StartElement:
			depth++
			if depth > maxDepth || len(value.Attr) > 256 {
				return errors.New("XML structure exceeds the configured limit")
			}
		case xml.EndElement:
			depth--
			if depth < 0 {
				return errors.New("XML element nesting is invalid")
			}
		case xml.Directive:
			return errors.New("XML directives are not supported")
		case xml.ProcInst:
			if !strings.EqualFold(value.Target, "xml") {
				return errors.New("XML processing instructions are not supported")
			}
		}
	}
}
