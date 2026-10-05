package thumbnail

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"math/rand"
	"testing"
)

func testImage(w, h int) *image.NRGBA {
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.SetNRGBA(x, y, color.NRGBA{R: uint8(x * 255 / w), G: uint8(y * 255 / h), B: 90, A: 255})
		}
	}
	return img
}

func pngBytes(t testing.TB, w, h int) []byte {
	t.Helper()
	var b bytes.Buffer
	if err := png.Encode(&b, testImage(w, h)); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func jpegBytes(t testing.TB, w, h int) []byte {
	t.Helper()
	var b bytes.Buffer
	if err := jpeg.Encode(&b, testImage(w, h), nil); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func gifBytes(t testing.TB, w, h int) []byte {
	t.Helper()
	var b bytes.Buffer
	if err := gif.Encode(&b, testImage(w, h), nil); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func extract(t testing.TB, data []byte, name, mt string) (Result, error) {
	t.Helper()
	return Extract(context.Background(), bytes.NewReader(data), int64(len(data)), name, mt)
}

func be32(v int) []byte { return binary.BigEndian.AppendUint32(nil, uint32(v)) }

func syncsafe32(v int) []byte {
	return []byte{byte(v >> 21 & 0x7f), byte(v >> 14 & 0x7f), byte(v >> 7 & 0x7f), byte(v & 0x7f)}
}

func id3v23(frames ...[]byte) []byte {
	body := bytes.Join(frames, nil)
	out := append([]byte("ID3\x03\x00\x00"), syncsafe32(len(body))...)
	return append(out, body...)
}

func apic(img []byte, pictureType byte) []byte {
	body := append([]byte{0}, []byte("image/png\x00")...)
	body = append(body, pictureType, 'c', 'o', 'v', 'e', 'r', 0)
	body = append(body, img...)
	return append(append([]byte("APIC"), be32(len(body))...), append([]byte{0, 0}, body...)...)
}

func flacWith(img []byte, pictureType int) []byte {
	pic := append(be32(pictureType), be32(9)...)
	pic = append(pic, "image/png"...)
	pic = append(pic, be32(0)...)
	pic = append(pic, make([]byte, 16)...)
	pic = append(pic, be32(len(img))...)
	pic = append(pic, img...)
	out := []byte("fLaC")
	out = append(out, 0, 0, 0, 4, 0, 0, 0, 0) // empty STREAMINFO stand-in, not last
	out = append(out, 0x80|6, byte(len(pic)>>16), byte(len(pic)>>8), byte(len(pic)))
	return append(out, pic...)
}

func box(kind string, payload ...[]byte) []byte {
	body := bytes.Join(payload, nil)
	return append(append(be32(8+len(body)), kind...), body...)
}

func m4aWith(img []byte) []byte {
	data := box("data", []byte{0, 0, 0, 14, 0, 0, 0, 0}, img)
	meta := box("meta", []byte{0, 0, 0, 0}, box("ilst", box("covr", data)))
	ftyp := box("ftyp", []byte("M4A \x00\x00\x00\x00M4A "))
	return append(ftyp, box("moov", box("udta", meta))...)
}

func epubWith(t testing.TB, opf string, extra map[string][]byte, entries int) []byte {
	t.Helper()
	var b bytes.Buffer
	zw := zip.NewWriter(&b)
	files := map[string][]byte{
		"META-INF/container.xml": []byte(`<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>`),
		"OEBPS/content.opf":      []byte(opf),
		"OEBPS/images/cover.png": pngBytes(t, 40, 60),
	}
	for k, v := range extra {
		files[k] = v
	}
	for name, data := range files {
		w, _ := zw.Create(name)
		w.Write(data)
	}
	for i := 0; i < entries; i++ {
		zw.Create(fmt.Sprintf("pad/%d", i))
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func opfDoc(meta, items string) string {
	return `<package xmlns="http://www.idpf.org/2007/opf"><metadata>` + meta + `</metadata><manifest>` + items + `</manifest></package>`
}

func TestExtractSucceeds(t *testing.T) {
	cover := pngBytes(t, 30, 20)
	cases := []struct {
		name, file, mt string
		data           []byte
		kind           Kind
		w, h           int
	}{
		{"png small not enlarged", "a.png", "", pngBytes(t, 100, 50), KindImage, 100, 50},
		{"png scaled", "a.png", "", pngBytes(t, 1000, 500), KindImage, 480, 240},
		{"jpeg tall scaled", "a.jpg", "image/jpeg", jpegBytes(t, 300, 960), KindImage, 150, 480},
		{"gif", "a.gif", "", gifBytes(t, 64, 64), KindImage, 64, 64},
		{"declared type is ignored", "a.txt", "text/plain", pngBytes(t, 10, 10), KindImage, 10, 10},
		{"mp3 apic", "a.mp3", "", id3v23(apic(cover, 3)), KindAudioCover, 30, 20},
		{"mp3 prefers front cover", "a.mp3", "", id3v23(apic(pngBytes(t, 8, 8), 0), apic(cover, 3)), KindAudioCover, 30, 20},
		{"flac picture", "a.flac", "", flacWith(cover, 3), KindAudioCover, 30, 20},
		{"m4a covr", "a.m4a", "", m4aWith(cover), KindAudioCover, 30, 20},
		{"epub3 cover-image property", "b.epub", "", epubWith(t, opfDoc("", `<item id="x" href="images/cover.png" media-type="image/png" properties="cover-image"/>`), nil, 0), KindEPUBCover, 40, 60},
		{"epub2 meta cover", "b.epub", "", epubWith(t, opfDoc(`<meta name="cover" content="pic"/>`, `<item id="pic" href="images/cover.png" media-type="image/png"/>`), nil, 0), KindEPUBCover, 40, 60},
		{"epub id contains cover", "b.epub", "", epubWith(t, opfDoc("", `<item id="my-cover" href="images/cover.png" media-type="image/png"/>`), nil, 0), KindEPUBCover, 40, 60},
		{"epub by media type only", "book", "application/epub+zip", epubWith(t, opfDoc("", `<item id="c" href="images/cover.png" media-type="image/png"/>`), nil, 0), KindEPUBCover, 40, 60},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res, err := extract(t, tc.data, tc.file, tc.mt)
			if err != nil {
				t.Fatal(err)
			}
			if res.Kind != tc.kind || res.Width != tc.w || res.Height != tc.h {
				t.Fatalf("got %s %dx%d, want %s %dx%d", res.Kind, res.Width, res.Height, tc.kind, tc.w, tc.h)
			}
			cfg, err := jpeg.DecodeConfig(bytes.NewReader(res.JPEG))
			if err != nil || cfg.Width != tc.w || cfg.Height != tc.h {
				t.Fatalf("encoded jpeg mismatch: %v %+v", err, cfg)
			}
			again, _ := extract(t, tc.data, tc.file, tc.mt)
			if !bytes.Equal(again.JPEG, res.JPEG) {
				t.Fatal("output is not deterministic")
			}
		})
	}
}

func TestExtractRefuses(t *testing.T) {
	// A PNG header declaring 10000x10000 with no pixel data: decoding would fail differently, so
	// ErrTooLarge proves the limit is applied from the header.
	ihdr := append(be32(10000), be32(10000)...)
	ihdr = append(ihdr, 8, 6, 0, 0, 0)
	chunk := append(be32(len(ihdr)), "IHDR"...)
	chunk = append(chunk, ihdr...)
	chunk = append(chunk, be32(int(crc32.ChecksumIEEE(chunk[4:])))...)
	huge := append([]byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}, chunk...)

	many := epubWith(t, opfDoc("", `<item id="c" href="images/cover.png" media-type="image/png"/>`), nil, MaxArchiveEntries+1)
	escape := epubWith(t, opfDoc("", `<item id="c" href="../../cover.png" media-type="image/png" properties="cover-image"/>`), map[string][]byte{"cover.png": pngBytes(t, 5, 5)}, 0)
	noCover := epubWith(t, opfDoc("", `<item id="t" href="ch1.xhtml" media-type="application/xhtml+xml"/>`), nil, 0)
	bigEntry := epubWith(t, opfDoc("", `<item id="c" href="images/cover.png" media-type="image/png"/>`), map[string][]byte{"OEBPS/images/cover.png": make([]byte, MaxArchiveEntryBytes+1)}, 0)

	cases := []struct {
		name string
		data []byte
		file string
		want error
	}{
		{"png over pixel limit", huge, "a.png", ErrTooLarge},
		{"epub with too many entries", many, "b.epub", ErrTooLarge},
		{"epub entry over limit", bigEntry, "b.epub", ErrTooLarge},
		{"epub href escaping the archive", escape, "b.epub", ErrNoThumbnail},
		{"epub without a cover", noCover, "b.epub", ErrNoThumbnail},
		{"zip that is not declared an epub", noCover, "b.zip", ErrNoThumbnail},
		{"mp3 without art", id3v23(), "a.mp3", ErrNoThumbnail},
		{"mp3 with unsynchronisation flag", append([]byte("ID3\x03\x00\x80\x00\x00\x00\x00"), 0), "a.mp3", ErrNoThumbnail},
		{"pdf", []byte("%PDF-1.7\n"), "a.pdf", ErrNoThumbnail},
		{"avif", append([]byte{0, 0, 0, 24}, "ftypavif\x00\x00\x00\x00avifmif1"...), "a.avif", ErrNoThumbnail},
		{"ogg", append([]byte("OggS"), make([]byte, 64)...), "a.ogg", ErrNoThumbnail},
		{"empty", nil, "a.png", ErrNoThumbnail},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := extract(t, tc.data, tc.file, ""); !errors.Is(err, tc.want) {
				t.Fatalf("got %v, want %v", err, tc.want)
			}
		})
	}
}

func TestExtractHonoursCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	data := pngBytes(t, 10, 10)
	if _, err := Extract(ctx, bytes.NewReader(data), int64(len(data)), "a.png", ""); !errors.Is(err, context.Canceled) {
		t.Fatalf("got %v", err)
	}
}

func TestExifOrientationRotatesThumbnail(t *testing.T) {
	// Build a JPEG with an Exif APP1 segment declaring orientation 6 (rotate 90 clockwise).
	src := jpegBytes(t, 200, 100)
	tiff := []byte{'M', 'M', 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0}
	seg := append([]byte("Exif\x00\x00"), tiff...)
	app1 := append([]byte{0xff, 0xe1, byte((len(seg) + 2) >> 8), byte(len(seg) + 2)}, seg...)
	data := append(append(append([]byte{}, src[:2]...), app1...), src[2:]...)
	res, err := extract(t, data, "a.jpg", "")
	if err != nil {
		t.Fatal(err)
	}
	if res.Width != 100 || res.Height != 200 {
		t.Fatalf("got %dx%d, want 100x200", res.Width, res.Height)
	}
}

// Truncated and corrupted copies of every fixture, and random bytes behind each magic prefix, must
// come back as an error or ErrNoThumbnail without panicking.
func TestMalformedInputNeverPanics(t *testing.T) {
	cover := pngBytes(t, 30, 20)
	fixtures := map[string][]byte{
		"a.png":  pngBytes(t, 50, 50),
		"a.jpg":  jpegBytes(t, 50, 50),
		"a.gif":  gifBytes(t, 50, 50),
		"a.mp3":  id3v23(apic(cover, 3)),
		"a.flac": flacWith(cover, 3),
		"a.m4a":  m4aWith(cover),
		"b.epub": epubWith(t, opfDoc("", `<item id="c" href="images/cover.png" media-type="image/png" properties="cover-image"/>`), nil, 0),
	}
	rng := rand.New(rand.NewSource(1))
	for name, data := range fixtures {
		for cut := 0; cut < len(data); cut += max(1, len(data)/64) {
			extractNoPanic(t, name, data[:cut])
		}
		for i := 0; i < 200; i++ {
			mutated := append([]byte{}, data...)
			for j := 0; j < 1+rng.Intn(4); j++ {
				mutated[rng.Intn(len(mutated))] = byte(rng.Intn(256))
			}
			extractNoPanic(t, name, mutated)
		}
	}
	prefixes := map[string][]byte{
		"a.png": {0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}, "a.jpg": {0xff, 0xd8, 0xff, 0xe1},
		"a.gif": []byte("GIF89a"), "a.webp": []byte("RIFF\x10\x00\x00\x00WEBPVP8 "), "a.bmp": []byte("BM"),
		"a.mp3": []byte("ID3\x03\x00\x00\x00\x00\x01\x00APIC"), "a.flac": []byte("fLaC\x00\x00\x00\x22"),
		"a.m4a": []byte("\x00\x00\x00\x18ftypM4A "), "b.epub": []byte("PK\x03\x04"),
	}
	for name, prefix := range prefixes {
		for i := 0; i < 300; i++ {
			tail := make([]byte, rng.Intn(300))
			rng.Read(tail)
			extractNoPanic(t, name, append(append([]byte{}, prefix...), tail...))
		}
	}
}

func extractNoPanic(t *testing.T, name string, data []byte) {
	t.Helper()
	_, err := extract(t, data, name, "")
	if err != nil && errors.Is(err, errDecoderPanic) {
		t.Fatalf("%s: parser panicked: %v", name, err)
	}
}
