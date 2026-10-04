package thumbnail

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"io"
)

const (
	// pictureFrameSlack covers the small header in front of the image bytes in a picture frame.
	pictureFrameSlack = 4096
	maxPictureFrame   = MaxEmbeddedImageBytes + pictureFrameSlack
	maxPictureFrames  = 8
	maxID3Frames      = 4096
	maxFLACBlocks     = 1024
	maxBoxDepth       = 8
	maxBoxesPerLevel  = 10000
)

var errNotFound = fmt.Errorf("%w: no embedded picture", errMalformed)

// syncsafe decodes four 7-bit bytes, rejecting any byte with the high bit set.
func syncsafe(b []byte) (int64, bool) {
	var v int64
	for _, c := range b[:4] {
		if c&0x80 != 0 {
			return 0, false
		}
		v = v<<7 | int64(c)
	}
	return v, true
}

// id3Cover returns the image bytes of the best APIC (v2.3, v2.4) or PIC (v2.2) frame, preferring
// the front cover. Tags that set the whole-tag unsynchronisation flag are skipped rather than
// rewritten, and so are individually compressed, encrypted or unsynchronised frames.
func id3Cover(ctx context.Context, r io.ReaderAt, size int64) ([]byte, error) {
	hdr, err := readRange(r, 0, 10, size, 10)
	if err != nil {
		return nil, err
	}
	version, flags := hdr[3], hdr[5]
	if string(hdr[:3]) != "ID3" || version < 2 || version > 4 {
		return nil, fmt.Errorf("%w: unsupported ID3 version", errMalformed)
	}
	if flags&0x80 != 0 {
		return nil, fmt.Errorf("%w: unsynchronised ID3 tag skipped", errMalformed)
	}
	tagSize, ok := syncsafe(hdr[6:10])
	if !ok {
		return nil, fmt.Errorf("%w: bad ID3 size", errMalformed)
	}
	end := min(10+tagSize, size)
	pos := int64(10)
	if version >= 3 && flags&0x40 != 0 {
		ext, err := readRange(r, pos, 4, size, 4)
		if err != nil {
			return nil, err
		}
		var n int64
		if version == 3 {
			n = int64(binary.BigEndian.Uint32(ext)) + 4
		} else if n, ok = syncsafe(ext); !ok {
			return nil, fmt.Errorf("%w: bad ID3 extended header", errMalformed)
		}
		pos += n
	}
	idLen, hdrLen := int64(4), int64(10)
	if version == 2 {
		idLen, hdrLen = 3, 6
	}
	var best []byte
	pictures := 0
	for n := 0; n < maxID3Frames && pos+hdrLen <= end; n++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		fh, err := readRange(r, pos, hdrLen, size, hdrLen)
		if err != nil {
			return nil, err
		}
		if fh[0] == 0 {
			break // padding
		}
		if !validFrameID(fh[:idLen]) {
			break
		}
		var fsize int64
		switch version {
		case 2:
			fsize = int64(fh[3])<<16 | int64(fh[4])<<8 | int64(fh[5])
		case 3:
			fsize = int64(binary.BigEndian.Uint32(fh[4:8]))
		default:
			if fsize, ok = syncsafe(fh[4:8]); !ok {
				return nil, fmt.Errorf("%w: bad ID3 frame size", errMalformed)
			}
		}
		body := pos + hdrLen
		if fsize > end-body {
			break
		}
		id := string(fh[:idLen])
		isPicture := (version == 2 && id == "PIC") || (version > 2 && id == "APIC")
		if isPicture && fsize > 0 && fsize <= maxPictureFrame && pictures < maxPictureFrames {
			if skip, prefix := frameFlags(version, fh[8:10]); !skip && prefix < fsize {
				pictures++
				data, err := readRange(r, body+prefix, fsize-prefix, size, maxPictureFrame)
				if err != nil {
					return nil, err
				}
				if pic, kind, ok := parseID3Picture(version, data); ok {
					if kind == 3 {
						return pic, nil
					}
					if best == nil {
						best = pic
					}
				}
			}
		}
		pos = body + fsize
	}
	if best == nil {
		return nil, errNotFound
	}
	return best, nil
}

func validFrameID(id []byte) bool {
	for _, c := range id {
		if (c < 'A' || c > 'Z') && (c < '0' || c > '9') {
			return false
		}
	}
	return true
}

// frameFlags reports whether a frame must be skipped and how many bytes of optional prefix
// (group id, data length indicator) sit before its payload.
func frameFlags(version byte, f []byte) (skip bool, prefix int64) {
	switch version {
	case 3:
		if f[1]&0xc0 != 0 { // compressed or encrypted
			return true, 0
		}
		if f[1]&0x20 != 0 {
			prefix = 1
		}
	case 4:
		if f[1]&0x0e != 0 { // compressed, encrypted or unsynchronised
			return true, 0
		}
		if f[1]&0x40 != 0 {
			prefix++
		}
		if f[1]&0x01 != 0 {
			prefix += 4
		}
	}
	return false, prefix
}

// parseID3Picture splits an APIC or PIC body into image bytes and picture type.
func parseID3Picture(version byte, b []byte) (img []byte, pictureType byte, ok bool) {
	if len(b) < 2 {
		return nil, 0, false
	}
	encoding := b[0]
	p := 1
	if version == 2 {
		p += 3 // three-character image format
	} else {
		i := bytes.IndexByte(b[p:], 0)
		if i < 0 {
			return nil, 0, false
		}
		p += i + 1
	}
	if p >= len(b) {
		return nil, 0, false
	}
	pictureType = b[p]
	p++
	switch encoding {
	case 0, 3:
		i := bytes.IndexByte(b[p:], 0)
		if i < 0 {
			return nil, 0, false
		}
		p += i + 1
	case 1, 2:
		found := false
		for i := p; i+1 < len(b); i += 2 {
			if b[i] == 0 && b[i+1] == 0 {
				p, found = i+2, true
				break
			}
		}
		if !found {
			return nil, 0, false
		}
	default:
		return nil, 0, false
	}
	if p >= len(b) || len(b)-p > MaxEmbeddedImageBytes {
		return nil, 0, false
	}
	return b[p:], pictureType, true
}

// flacCover returns the first PICTURE metadata block, preferring picture type 3 (front cover).
func flacCover(ctx context.Context, r io.ReaderAt, size int64) ([]byte, error) {
	pos := int64(4)
	var best []byte
	for n := 0; n < maxFLACBlocks && pos+4 <= size; n++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		h, err := readRange(r, pos, 4, size, 4)
		if err != nil {
			return nil, err
		}
		last, kind := h[0]&0x80 != 0, h[0]&0x7f
		length := int64(h[1])<<16 | int64(h[2])<<8 | int64(h[3])
		body := pos + 4
		if length > size-body {
			return nil, fmt.Errorf("%w: FLAC block past end", errMalformed)
		}
		if kind == 6 && length <= maxPictureFrame {
			data, err := readRange(r, body, length, size, maxPictureFrame)
			if err != nil {
				return nil, err
			}
			if pic, pictureType, ok := parseFLACPicture(data); ok {
				if pictureType == 3 {
					return pic, nil
				}
				if best == nil {
					best = pic
				}
			}
		}
		if last {
			break
		}
		pos = body + length
	}
	if best == nil {
		return nil, errNotFound
	}
	return best, nil
}

func parseFLACPicture(b []byte) (img []byte, pictureType uint32, ok bool) {
	p := 0
	u32 := func() (uint32, bool) {
		if len(b)-p < 4 {
			return 0, false
		}
		v := binary.BigEndian.Uint32(b[p:])
		p += 4
		return v, true
	}
	skip := func() bool { // a length-prefixed string
		n, ok := u32()
		if !ok || uint64(n) > uint64(len(b)-p) {
			return false
		}
		p += int(n)
		return true
	}
	pictureType, ok = u32()
	if !ok || !skip() || !skip() { // media type, description
		return nil, 0, false
	}
	if len(b)-p < 16 { // width, height, depth, colours
		return nil, 0, false
	}
	p += 16
	n, ok := u32()
	if !ok || n == 0 || n > MaxEmbeddedImageBytes || uint64(n) > uint64(len(b)-p) {
		return nil, 0, false
	}
	return b[p : p+int(n)], pictureType, true
}

// mp4Cover walks the box tree to moov/udta/meta/ilst/covr/data (and the same without udta, which
// some writers use) with a depth limit and a per-level box limit.
func mp4Cover(ctx context.Context, r io.ReaderAt, size int64) ([]byte, error) {
	for _, p := range [][]string{
		{"moov", "udta", "meta", "ilst", "covr", "data"},
		{"moov", "meta", "ilst", "covr", "data"},
	} {
		img, err := findBox(ctx, r, 0, size, size, p, 0)
		if err == nil {
			return img, nil
		}
		if err != errNotFound {
			return nil, err
		}
	}
	return nil, errNotFound
}

func findBox(ctx context.Context, r io.ReaderAt, start, end, size int64, path []string, depth int) ([]byte, error) {
	if depth > maxBoxDepth {
		return nil, fmt.Errorf("%w: boxes nested too deeply", errMalformed)
	}
	pos := start
	for n := 0; n < maxBoxesPerLevel && pos+8 <= end; n++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		h, err := readRange(r, pos, 8, size, 8)
		if err != nil {
			return nil, err
		}
		boxSize, kind, headerLen := uint64(binary.BigEndian.Uint32(h)), string(h[4:8]), int64(8)
		switch boxSize {
		case 1:
			ext, err := readRange(r, pos+8, 8, size, 8)
			if err != nil {
				return nil, err
			}
			boxSize, headerLen = binary.BigEndian.Uint64(ext), 16
		case 0:
			boxSize = uint64(end - pos)
		}
		if boxSize < uint64(headerLen) || boxSize > uint64(end-pos) {
			return nil, fmt.Errorf("%w: box size out of range", errMalformed)
		}
		boxEnd := pos + int64(boxSize)
		if kind == path[0] {
			body := pos + headerLen
			if len(path) == 1 {
				// A data box: 4 bytes of type and flags, 4 reserved, then the payload.
				if payload := boxEnd - (body + 8); payload > 0 && payload <= MaxEmbeddedImageBytes {
					img, err := readRange(r, body+8, payload, size, MaxEmbeddedImageBytes)
					if err != nil {
						return nil, err
					}
					if bytes.HasPrefix(img, []byte{0xff, 0xd8}) || bytes.HasPrefix(img, []byte{0x89, 'P', 'N', 'G'}) {
						return img, nil
					}
				}
			} else {
				if kind == "meta" {
					body += 4 // meta is a full box
				}
				img, err := findBox(ctx, r, body, boxEnd, size, path[1:], depth+1)
				if err == nil {
					return img, nil
				}
				if err != errNotFound {
					return nil, err
				}
			}
		}
		pos = boxEnd
	}
	return nil, errNotFound
}
