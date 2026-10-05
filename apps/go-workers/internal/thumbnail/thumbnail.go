// Package thumbnail extracts a small preview image from an uploaded file.
//
// The input is untrusted, so every parser here is bounded in memory and in the number of steps it
// takes, and none of them trusts a declared size before checking it against a constant. The format
// is decided by sniffing the bytes; the file name and declared media type are only a tie-breaker
// for containers (an EPUB is a ZIP, and a ZIP alone says nothing about being a book).
//
// Supported sources:
//   - Images: PNG, JPEG (EXIF orientation honoured), GIF (first frame), WebP (still images only)
//     and BMP.
//   - Audio cover art: MP3 (ID3v2.2, 2.3 and 2.4), FLAC and MP4/M4A.
//   - EPUB covers.
//
// Deliberately skipped, each answered with ErrNoThumbnail: AVIF and HEIC (there is no pure-Go
// decoder), Ogg/Opus/Vorbis cover art (METADATA_BLOCK_PICTURE is base64 inside a comment packet
// and is not worth a hand parser), ID3 tags that use whole-tag unsynchronisation, and PDF (first
// pages are rendered in the browser, not here).
//
// Context cancellation is honoured between stages. A single image decode cannot be interrupted,
// but its cost is bounded by MaxSourcePixels.
package thumbnail

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"io"
	"path"
	"strings"

	// Decoders are registered for image.DecodeConfig and image.Decode.
	_ "image/gif"
	_ "image/png"

	_ "golang.org/x/image/bmp"
	xdraw "golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

// Kind says where a thumbnail came from.
type Kind string

const (
	KindImage      Kind = "image"
	KindAudioCover Kind = "audio-cover"
	KindEPUBCover  Kind = "epub-cover"
)

const (
	// MaxSide is the longest side, in pixels, of a produced thumbnail. Smaller sources are never
	// scaled up.
	MaxSide = 480
	// JPEGQuality is the quality the thumbnail is encoded at.
	JPEGQuality = 82
	// MaxSourcePixels is the largest declared width*height that will be decoded. It is checked from
	// the image header before any pixel buffer is allocated.
	MaxSourcePixels = 40_000_000
	// MaxEmbeddedImageBytes is the largest cover image read out of an audio tag.
	MaxEmbeddedImageBytes = 10 << 20
	// MaxArchiveEntries is the most entries an EPUB may declare.
	MaxArchiveEntries = 5000
	// MaxArchiveEntryBytes is the most uncompressed bytes read from any single EPUB entry.
	MaxArchiveEntryBytes = 20 << 20
	// MaxImageFileBytes is the largest standalone image file that will be read into memory.
	MaxImageFileBytes = 64 << 20
)

// Result is an encoded thumbnail.
type Result struct {
	JPEG   []byte
	Width  int
	Height int
	Kind   Kind
}

// ErrNoThumbnail is a normal outcome: the file has nothing to show, or what it has could not be
// parsed. Malformed input wraps it so callers can use errors.Is.
var ErrNoThumbnail = errors.New("thumbnail: none available")

// ErrTooLarge means the source or something inside it exceeded a limit.
var ErrTooLarge = errors.New("thumbnail: source exceeds limits")

var errDecoderPanic = errors.New("thumbnail: parser panicked")

const sniffBytes = 32

type format int

const (
	formatNone format = iota
	formatImage
	formatMP3
	formatFLAC
	formatMP4
	formatZIP
)

// Extract reads at most the bytes it needs from r (size is the total length) and returns a
// thumbnail whose longer side is at most MaxSide, or ErrNoThumbnail.
func Extract(ctx context.Context, r io.ReaderAt, size int64, fileName, mediaType string) (res Result, err error) {
	// Decoders of untrusted images have panicked on crafted input before, and a worker handling a
	// queue must survive that, so every panic is turned into an error at this boundary.
	defer func() {
		if p := recover(); p != nil {
			res, err = Result{}, fmt.Errorf("%w: %v", errDecoderPanic, p)
		}
	}()
	if err := ctx.Err(); err != nil {
		return Result{}, err
	}
	if r == nil || size <= 0 {
		return Result{}, ErrNoThumbnail
	}
	head, err := readRange(r, 0, min(size, sniffBytes), size, sniffBytes)
	if err != nil {
		return Result{}, classify(ctx, err)
	}
	res, err = dispatch(ctx, r, size, sniff(head, fileName, mediaType))
	if err != nil {
		return Result{}, classify(ctx, err)
	}
	return res, nil
}

func dispatch(ctx context.Context, r io.ReaderAt, size int64, f format) (Result, error) {
	var (
		embedded []byte
		err      error
	)
	switch f {
	case formatImage:
		if size > MaxImageFileBytes {
			return Result{}, ErrTooLarge
		}
		data, err := readRange(r, 0, size, size, MaxImageFileBytes)
		if err != nil {
			return Result{}, err
		}
		return renderImage(ctx, data, KindImage)
	case formatMP3:
		embedded, err = id3Cover(ctx, r, size)
	case formatFLAC:
		embedded, err = flacCover(ctx, r, size)
	case formatMP4:
		embedded, err = mp4Cover(ctx, r, size)
	case formatZIP:
		return epubCover(ctx, r, size)
	default:
		return Result{}, ErrNoThumbnail
	}
	if err != nil {
		return Result{}, err
	}
	if err := ctx.Err(); err != nil {
		return Result{}, err
	}
	return renderImage(ctx, embedded, KindAudioCover)
}

// classify turns parser failures into ErrNoThumbnail while letting limits, cancellation and
// panics through unchanged.
func classify(ctx context.Context, err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, ErrNoThumbnail), errors.Is(err, ErrTooLarge), errors.Is(err, errDecoderPanic):
		return err
	case ctx.Err() != nil:
		return ctx.Err()
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		return err
	}
	return fmt.Errorf("%w: %v", ErrNoThumbnail, err)
}

func sniff(head []byte, fileName, mediaType string) format {
	switch {
	case bytes.HasPrefix(head, []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}),
		bytes.HasPrefix(head, []byte{0xff, 0xd8, 0xff}),
		bytes.HasPrefix(head, []byte("GIF87a")), bytes.HasPrefix(head, []byte("GIF89a")),
		len(head) >= 12 && string(head[:4]) == "RIFF" && string(head[8:12]) == "WEBP",
		bytes.HasPrefix(head, []byte("BM")):
		return formatImage
	case bytes.HasPrefix(head, []byte("ID3")):
		return formatMP3
	case bytes.HasPrefix(head, []byte("fLaC")):
		return formatFLAC
	case len(head) >= 12 && string(head[4:8]) == "ftyp":
		switch string(head[8:12]) {
		case "avif", "avis", "heic", "heix", "heim", "heis", "hevc", "hevx", "mif1", "msf1":
			return formatNone
		}
		return formatMP4
	case bytes.HasPrefix(head, []byte("PK\x03\x04")):
		ext := strings.ToLower(path.Ext(fileName))
		mt := strings.ToLower(strings.TrimSpace(strings.SplitN(mediaType, ";", 2)[0]))
		if ext == ".epub" || mt == "application/epub+zip" {
			return formatZIP
		}
	}
	return formatNone
}

var errMalformed = errors.New("malformed")

// readRange reads exactly n bytes at off, refusing anything outside [0,size] or above limit, so a
// declared length can never drive an allocation on its own.
func readRange(r io.ReaderAt, off, n, size, limit int64) ([]byte, error) {
	if off < 0 || n < 0 || off > size || n > size-off {
		return nil, fmt.Errorf("%w: range outside file", errMalformed)
	}
	if n > limit {
		return nil, fmt.Errorf("%w: range over limit", errMalformed)
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(io.NewSectionReader(r, off, n), buf); err != nil {
		return nil, fmt.Errorf("%w: %v", errMalformed, err)
	}
	return buf, nil
}

// renderImage decodes data, enforces the pixel limit from the header first, scales, orients and
// encodes it.
func renderImage(ctx context.Context, data []byte, kind Kind) (Result, error) {
	if len(data) == 0 {
		return Result{}, fmt.Errorf("%w: empty image", errMalformed)
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return Result{}, fmt.Errorf("%w: image header: %v", errMalformed, err)
	}
	if cfg.Width <= 0 || cfg.Height <= 0 {
		return Result{}, fmt.Errorf("%w: image has no area", errMalformed)
	}
	if int64(cfg.Width)*int64(cfg.Height) > MaxSourcePixels {
		return Result{}, ErrTooLarge
	}
	if err := ctx.Err(); err != nil {
		return Result{}, err
	}
	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return Result{}, fmt.Errorf("%w: image decode: %v", errMalformed, err)
	}
	if err := ctx.Err(); err != nil {
		return Result{}, err
	}
	orientation := 1
	if bytes.HasPrefix(data, []byte{0xff, 0xd8}) {
		orientation = jpegOrientation(data)
	}
	thumb := orient(scale(img), orientation)
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, thumb, &jpeg.Options{Quality: JPEGQuality}); err != nil {
		return Result{}, fmt.Errorf("thumbnail: encode: %w", err)
	}
	b := thumb.Bounds()
	return Result{JPEG: buf.Bytes(), Width: b.Dx(), Height: b.Dy(), Kind: kind}, nil
}

// scale fits img inside MaxSide without enlarging it and flattens transparency onto white.
func scale(img image.Image) *image.RGBA {
	b := img.Bounds()
	w, h := int64(b.Dx()), int64(b.Dy())
	nw, nh := w, h
	if longer := max(w, h); longer > MaxSide {
		nw = max(1, w*MaxSide/longer)
		nh = max(1, h*MaxSide/longer)
	}
	dst := image.NewRGBA(image.Rect(0, 0, int(nw), int(nh)))
	xdraw.Draw(dst, dst.Bounds(), image.NewUniform(color.White), image.Point{}, xdraw.Src)
	xdraw.CatmullRom.Scale(dst, dst.Bounds(), img, b, xdraw.Over, nil)
	return dst
}

// orient applies an EXIF orientation (1 to 8) to the already-small thumbnail, which is far
// cheaper than rotating the source.
func orient(src *image.RGBA, o int) *image.RGBA {
	if o < 2 || o > 8 {
		return src
	}
	w, h := src.Bounds().Dx(), src.Bounds().Dy()
	dw, dh := w, h
	if o >= 5 {
		dw, dh = h, w
	}
	dst := image.NewRGBA(image.Rect(0, 0, dw, dh))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			var dx, dy int
			switch o {
			case 2:
				dx, dy = w-1-x, y
			case 3:
				dx, dy = w-1-x, h-1-y
			case 4:
				dx, dy = x, h-1-y
			case 5:
				dx, dy = y, x
			case 6:
				dx, dy = h-1-y, x
			case 7:
				dx, dy = h-1-y, w-1-x
			case 8:
				dx, dy = y, w-1-x
			}
			dst.SetRGBA(dx, dy, src.RGBAAt(x, y))
		}
	}
	return dst
}

const (
	maxEXIFScanBytes = 128 << 10
	maxEXIFEntries   = 512
)

// jpegOrientation finds the EXIF orientation in the leading JPEG segments, or 1 when absent or
// unreadable. It never looks past the first maxEXIFScanBytes.
func jpegOrientation(data []byte) int {
	pos := 2
	for pos+4 <= len(data) && pos < maxEXIFScanBytes {
		if data[pos] != 0xff {
			return 1
		}
		marker := data[pos+1]
		if marker == 0xff {
			pos++
			continue
		}
		if marker == 0x01 || (marker >= 0xd0 && marker <= 0xd7) {
			pos += 2
			continue
		}
		if marker == 0xda || marker == 0xd9 {
			return 1
		}
		segLen := int(data[pos+2])<<8 | int(data[pos+3])
		if segLen < 2 || pos+2+segLen > len(data) {
			return 1
		}
		if marker == 0xe1 && segLen >= 2+6 && string(data[pos+4:pos+10]) == "Exif\x00\x00" {
			return tiffOrientation(data[pos+10 : pos+2+segLen])
		}
		pos += 2 + segLen
	}
	return 1
}

func tiffOrientation(t []byte) int {
	if len(t) < 8 {
		return 1
	}
	u16 := func(b []byte) int { return int(b[0])<<8 | int(b[1]) }
	u32 := func(b []byte) int64 { return int64(b[0])<<24 | int64(b[1])<<16 | int64(b[2])<<8 | int64(b[3]) }
	swap := false
	switch string(t[:2]) {
	case "MM":
	case "II":
		swap = true
	default:
		return 1
	}
	if swap {
		u16 = func(b []byte) int { return int(b[1])<<8 | int(b[0]) }
		u32 = func(b []byte) int64 { return int64(b[3])<<24 | int64(b[2])<<16 | int64(b[1])<<8 | int64(b[0]) }
	}
	if u16(t[2:]) != 42 {
		return 1
	}
	ifd := u32(t[4:])
	if ifd < 8 || ifd+2 > int64(len(t)) {
		return 1
	}
	count := u16(t[ifd:])
	for i := 0; i < count && i < maxEXIFEntries; i++ {
		e := ifd + 2 + int64(i)*12
		if e+12 > int64(len(t)) {
			return 1
		}
		if u16(t[e:]) == 0x0112 && u16(t[e+2:]) == 3 && u32(t[e+4:]) == 1 {
			if v := u16(t[e+8:]); v >= 1 && v <= 8 {
				return v
			}
			return 1
		}
	}
	return 1
}
