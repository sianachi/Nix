package thumbnail

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/url"
	"path"
	"strings"
)

const (
	maxXMLBytes = 2 << 20
	// maxCentralDirectoryBytes bounds the ZIP directory the standard library will parse. The
	// library walks entries until the signature stops matching and does not stop at the declared
	// count, so the directory is checked against the end-of-directory record first.
	maxCentralDirectoryBytes = 1 << 20
	maxCoverCandidates       = 3
	eocdMinLen               = 22
)

// checkZIPDirectory validates the end-of-central-directory record before zip.NewReader is let
// near the archive: entry count, directory size and that the directory ends exactly where the
// record begins. ZIP64 archives and archives with data in front are refused.
func checkZIPDirectory(r io.ReaderAt, size int64) error {
	tailLen := min(size, eocdMinLen+0xffff)
	tail, err := readRange(r, size-tailLen, tailLen, size, eocdMinLen+0xffff)
	if err != nil {
		return err
	}
	for i := len(tail) - eocdMinLen; i >= 0; i-- {
		if binary.LittleEndian.Uint32(tail[i:]) != 0x06054b50 {
			continue
		}
		commentLen := int(binary.LittleEndian.Uint16(tail[i+20:]))
		if i+eocdMinLen+commentLen != len(tail) {
			continue
		}
		entries := binary.LittleEndian.Uint16(tail[i+10:])
		dirSize := binary.LittleEndian.Uint32(tail[i+12:])
		dirOffset := binary.LittleEndian.Uint32(tail[i+16:])
		if entries == 0xffff || dirSize == 0xffffffff || dirOffset == 0xffffffff {
			return ErrTooLarge
		}
		if int(entries) > MaxArchiveEntries || dirSize > maxCentralDirectoryBytes {
			return ErrTooLarge
		}
		eocdPos := size - int64(len(tail)) + int64(i)
		if int64(dirOffset)+int64(dirSize) != eocdPos {
			return fmt.Errorf("%w: unusual ZIP layout", errMalformed)
		}
		return nil
	}
	return fmt.Errorf("%w: no ZIP directory", errMalformed)
}

type opfItem struct {
	ID         string `xml:"id,attr"`
	Href       string `xml:"href,attr"`
	MediaType  string `xml:"media-type,attr"`
	Properties string `xml:"properties,attr"`
}

type opfPackage struct {
	Meta []struct {
		Name    string `xml:"name,attr"`
		Content string `xml:"content,attr"`
	} `xml:"metadata>meta"`
	Items []opfItem `xml:"manifest>item"`
}

// epubCover finds the cover through the three discovery rules in order: an EPUB 3 manifest item
// with the cover-image property, an EPUB 2 meta name="cover" resolved through the manifest, then
// a manifest image whose id or href mentions "cover".
func epubCover(ctx context.Context, r io.ReaderAt, size int64) (Result, error) {
	if err := checkZIPDirectory(r, size); err != nil {
		return Result{}, err
	}
	zr, err := zip.NewReader(r, size)
	if err != nil && !(errors.Is(err, zip.ErrInsecurePath) && zr != nil) {
		return Result{}, fmt.Errorf("%w: %v", errMalformed, err)
	}
	if len(zr.File) > MaxArchiveEntries {
		return Result{}, ErrTooLarge
	}
	files := make(map[string]*zip.File, len(zr.File))
	for _, f := range zr.File {
		if _, dup := files[f.Name]; !dup {
			files[f.Name] = f
		}
	}
	if err := ctx.Err(); err != nil {
		return Result{}, err
	}

	container, err := readEntry(files["META-INF/container.xml"], maxXMLBytes)
	if err != nil {
		return Result{}, err
	}
	opfPath, err := rootfilePath(container)
	if err != nil {
		return Result{}, err
	}
	opfPath = path.Clean(opfPath)
	opfData, err := readEntry(files[opfPath], maxXMLBytes)
	if err != nil {
		return Result{}, err
	}
	var pkg opfPackage
	if err := xml.NewDecoder(io.LimitReader(bytes.NewReader(opfData), maxXMLBytes)).Decode(&pkg); err != nil {
		return Result{}, fmt.Errorf("%w: package document: %v", errMalformed, err)
	}

	for _, item := range coverCandidates(pkg) {
		if err := ctx.Err(); err != nil {
			return Result{}, err
		}
		name, ok := resolveHref(path.Dir(opfPath), item.Href)
		if !ok {
			continue
		}
		data, err := readEntry(files[name], MaxArchiveEntryBytes)
		if errors.Is(err, ErrTooLarge) {
			return Result{}, err
		}
		if err != nil {
			continue
		}
		if res, err := renderImage(ctx, data, KindEPUBCover); err == nil {
			return res, nil
		} else if errors.Is(err, ErrTooLarge) || ctx.Err() != nil {
			return Result{}, err
		}
	}
	return Result{}, errNotFound
}

func coverCandidates(pkg opfPackage) []opfItem {
	byID := make(map[string]opfItem, len(pkg.Items))
	for _, it := range pkg.Items {
		if _, dup := byID[it.ID]; !dup {
			byID[it.ID] = it
		}
	}
	isImage := func(it opfItem) bool {
		return it.MediaType == "" || strings.HasPrefix(strings.ToLower(it.MediaType), "image/")
	}
	var out []opfItem
	add := func(it opfItem) {
		if len(out) < maxCoverCandidates && it.Href != "" && isImage(it) {
			out = append(out, it)
		}
	}
	for _, it := range pkg.Items {
		for _, prop := range strings.Fields(it.Properties) {
			if prop == "cover-image" {
				add(it)
			}
		}
	}
	for _, m := range pkg.Meta {
		if m.Name == "cover" {
			if it, ok := byID[m.Content]; ok {
				add(it)
			}
		}
	}
	for _, it := range pkg.Items {
		if strings.HasPrefix(strings.ToLower(it.MediaType), "image/") &&
			(strings.Contains(strings.ToLower(it.ID), "cover") || strings.Contains(strings.ToLower(it.Href), "cover")) {
			add(it)
		}
	}
	return out
}

// resolveHref resolves a manifest href against the OPF directory and rejects anything that is
// absolute, carries a scheme, or climbs out of the archive root.
func resolveHref(dir, href string) (string, bool) {
	if i := strings.IndexAny(href, "#?"); i >= 0 {
		href = href[:i]
	}
	href, err := url.PathUnescape(href)
	if err != nil || href == "" || strings.ContainsAny(href, "\x00\\") || strings.HasPrefix(href, "/") || strings.Contains(href, ":") {
		return "", false
	}
	name := path.Join(dir, href)
	if name == ".." || strings.HasPrefix(name, "../") || path.IsAbs(name) {
		return "", false
	}
	return name, true
}

func rootfilePath(container []byte) (string, error) {
	d := xml.NewDecoder(io.LimitReader(bytes.NewReader(container), maxXMLBytes))
	for {
		tok, err := d.Token()
		if err != nil {
			return "", fmt.Errorf("%w: container.xml: no rootfile", errMalformed)
		}
		if se, ok := tok.(xml.StartElement); ok && se.Name.Local == "rootfile" {
			for _, a := range se.Attr {
				if a.Name.Local == "full-path" && a.Value != "" {
					return a.Value, nil
				}
			}
		}
	}
}

// readEntry reads one archive entry, stopping at limit instead of trusting the declared size.
func readEntry(f *zip.File, limit int64) ([]byte, error) {
	if f == nil {
		return nil, fmt.Errorf("%w: entry missing", errMalformed)
	}
	if f.UncompressedSize64 > uint64(limit) {
		return nil, ErrTooLarge
	}
	rc, err := f.Open()
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errMalformed, err)
	}
	defer rc.Close()
	data, err := io.ReadAll(io.LimitReader(rc, limit+1))
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errMalformed, err)
	}
	if int64(len(data)) > limit {
		return nil, ErrTooLarge
	}
	return data, nil
}
