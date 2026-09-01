package importplan

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"path"
	"strings"

	"github.com/sianachi/Nix/apps/go-workers/internal/fileinspect"
)

type assetInspection struct {
	File
	Path string
}

func openArchive(source Source, limits Limits) (*zip.ReadCloser, error) {
	archive, err := zip.OpenReader(source.Path)
	if err != nil {
		return nil, err
	}
	if len(archive.File) > limits.MaxItems+100 {
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
		if expanded > uint64(limits.MaxSourceBytes) || entry.UncompressedSize64 > uint64(limits.MaxEntryBytes) {
			_ = archive.Close()
			return nil, errors.New("archive expands beyond the configured limits")
		}
	}
	return archive, nil
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
