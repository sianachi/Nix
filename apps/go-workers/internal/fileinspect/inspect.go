package fileinspect

import (
	"bytes"
	"encoding/binary"
	"hash/crc32"
	"unicode/utf8"
)

const (
	maxHeaderBytes = 64 * 1024
	previewBytes   = 10 * 1024 * 1024
	previewPixels  = 40_000_000
	maxImageSide   = 100_000
	maxBoxDepth    = 8
)

type Metadata struct {
	MediaType string
	Preview   bool
	Width     *int
	Height    *int
	Animated  bool
	Malformed bool
}

func InspectHeader(header []byte, totalBytes int64) Metadata {
	metadata := Metadata{MediaType: "application/octet-stream"}
	previewSafe := false
	switch {
	case len(header) >= 8 && bytes.Equal(header[:8], []byte{137, 80, 78, 71, 13, 10, 26, 10}):
		metadata.MediaType = "image/png"
		metadata.Width, metadata.Height, metadata.Animated, previewSafe, metadata.Malformed = pngMetadata(header, totalBytes)
	case len(header) >= 2 && header[0] == 0xff && header[1] == 0xd8:
		metadata.MediaType = "image/jpeg"
		metadata.Width, metadata.Height, previewSafe, metadata.Malformed = jpegMetadata(header, totalBytes)
	case len(header) >= 12 && string(header[:4]) == "RIFF" && string(header[8:12]) == "WEBP":
		metadata.MediaType = "image/webp"
		metadata.Width, metadata.Height, metadata.Animated, previewSafe, metadata.Malformed = webpMetadata(header, totalBytes)
	case looksLikeAVIF(header):
		metadata.MediaType = "image/avif"
		metadata.Width, metadata.Height, metadata.Animated, previewSafe, metadata.Malformed = avifMetadata(header, totalBytes)
	case len(header) >= 6 && (string(header[:6]) == "GIF87a" || string(header[:6]) == "GIF89a"):
		metadata.MediaType = "image/gif"
		if len(header) >= 10 {
			metadata.Width, metadata.Height = dimensions(
				uint64(binary.LittleEndian.Uint16(header[6:8])),
				uint64(binary.LittleEndian.Uint16(header[8:10])))
		}
		metadata.Animated = true
		metadata.Malformed = metadata.Width == nil || metadata.Height == nil
	case len(header) >= 5 && string(header[:5]) == "%PDF-":
		metadata.MediaType = "application/pdf"
	case len(header) >= 4 && bytes.Equal(header[:4], []byte{'P', 'K', 3, 4}):
		metadata.MediaType = "application/zip"
	case looksLikeSVG(header):
		metadata.MediaType = "image/svg+xml"
	case looksLikeText(header):
		metadata.MediaType = "text/plain"
	}

	if previewSafe && metadata.Width != nil && metadata.Height != nil {
		pixels := int64(*metadata.Width) * int64(*metadata.Height)
		metadata.Preview = !metadata.Animated && totalBytes >= 0 && totalBytes <= previewBytes && pixels > 0 && pixels <= previewPixels
	}
	return metadata
}

func pngMetadata(header []byte, totalBytes int64) (width, height *int, animated, previewSafe, malformed bool) {
	if len(header) < 33 || totalBytes < 33 {
		return nil, nil, false, false, true
	}
	if binary.BigEndian.Uint32(header[8:12]) != 13 || string(header[12:16]) != "IHDR" || !validPNGCRC(header[12:29], header[29:33]) {
		return nil, nil, false, false, true
	}
	width, height = dimensions(uint64(binary.BigEndian.Uint32(header[16:20])), uint64(binary.BigEndian.Uint32(header[20:24])))
	if width == nil || height == nil || !validPNGHeader(header[24], header[25], header[26], header[27], header[28]) {
		return nil, nil, false, false, true
	}

	for offset, chunks := 33, 0; chunks < 1024; chunks++ {
		if offset+8 > len(header) {
			return width, height, animated, false, totalBytes <= int64(len(header))
		}
		length := uint64(binary.BigEndian.Uint32(header[offset : offset+4]))
		chunkEnd := uint64(offset) + 12 + length
		if chunkEnd > uint64(totalBytes) {
			return width, height, animated, false, true
		}
		kind := string(header[offset+4 : offset+8])
		if kind == "IDAT" {
			return width, height, animated, true, false
		}
		if kind == "IEND" {
			return width, height, animated, false, true
		}
		if chunkEnd > uint64(len(header)) {
			return width, height, animated, false, false
		}
		dataEnd := offset + 8 + int(length)
		if !validPNGCRC(header[offset+4:dataEnd], header[dataEnd:dataEnd+4]) {
			return width, height, animated, false, true
		}
		if kind == "acTL" {
			if length != 8 {
				return width, height, false, false, true
			}
			animated = true
		}
		offset = int(chunkEnd)
	}
	return width, height, animated, false, true
}

func validPNGHeader(bitDepth, colorType, compression, filter, interlace byte) bool {
	if compression != 0 || filter != 0 || interlace > 1 {
		return false
	}
	switch colorType {
	case 0:
		return bitDepth == 1 || bitDepth == 2 || bitDepth == 4 || bitDepth == 8 || bitDepth == 16
	case 2, 4, 6:
		return bitDepth == 8 || bitDepth == 16
	case 3:
		return bitDepth == 1 || bitDepth == 2 || bitDepth == 4 || bitDepth == 8
	default:
		return false
	}
}

func validPNGCRC(body, expected []byte) bool {
	return len(expected) == 4 && crc32.ChecksumIEEE(body) == binary.BigEndian.Uint32(expected)
}

func jpegMetadata(header []byte, totalBytes int64) (width, height *int, previewSafe, malformed bool) {
	for offset, segments := 2, 0; segments < 4096; segments++ {
		if offset >= len(header) {
			return nil, nil, false, totalBytes <= int64(len(header))
		}
		if header[offset] != 0xff {
			return nil, nil, false, true
		}
		for offset < len(header) && header[offset] == 0xff {
			offset++
		}
		if offset >= len(header) {
			return nil, nil, false, totalBytes <= int64(len(header))
		}
		marker := header[offset]
		offset++
		if marker == 0xd9 || marker == 0xda {
			return nil, nil, false, true
		}
		if marker == 0xd8 || marker == 0x01 || marker >= 0xd0 && marker <= 0xd7 {
			continue
		}
		if offset+2 > len(header) {
			return nil, nil, false, totalBytes <= int64(len(header))
		}
		length := int(binary.BigEndian.Uint16(header[offset : offset+2]))
		if length < 2 || int64(offset+length) > totalBytes {
			return nil, nil, false, true
		}
		if offset+length > len(header) {
			return nil, nil, false, false
		}
		if isStartOfFrame(marker) {
			if length < 8 {
				return nil, nil, false, true
			}
			components := int(header[offset+7])
			if components == 0 || length != 8+3*components {
				return nil, nil, false, true
			}
			width, height = dimensions(
				uint64(binary.BigEndian.Uint16(header[offset+5:offset+7])),
				uint64(binary.BigEndian.Uint16(header[offset+3:offset+5])))
			if width == nil || height == nil {
				return nil, nil, false, true
			}
			return width, height, true, false
		}
		offset += length
	}
	return nil, nil, false, true
}

func isStartOfFrame(marker byte) bool {
	return marker >= 0xc0 && marker <= 0xcf && marker != 0xc4 && marker != 0xc8 && marker != 0xcc
}

func webpMetadata(header []byte, totalBytes int64) (width, height *int, animated, previewSafe, malformed bool) {
	if len(header) < 20 || totalBytes < 20 || uint64(binary.LittleEndian.Uint32(header[4:8]))+8 != uint64(totalBytes) {
		return nil, nil, false, false, true
	}
	chunkSize := uint64(binary.LittleEndian.Uint32(header[16:20]))
	chunkEnd := uint64(20) + chunkSize
	if chunkEnd > uint64(totalBytes) {
		return nil, nil, false, false, true
	}
	switch string(header[12:16]) {
	case "VP8X":
		if chunkSize != 10 || len(header) < 30 {
			return nil, nil, false, false, true
		}
		flags := header[20]
		if flags&0xc1 != 0 || header[21] != 0 || header[22] != 0 || header[23] != 0 {
			return nil, nil, false, false, true
		}
		width, height = dimensions(uint64(1+little24(header[24:27])), uint64(1+little24(header[27:30])))
		animated = flags&0x02 != 0
	case "VP8 ":
		if chunkSize < 10 || len(header) < 30 || header[20]&1 != 0 || !bytes.Equal(header[23:26], []byte{0x9d, 0x01, 0x2a}) {
			return nil, nil, false, false, true
		}
		width, height = dimensions(
			uint64(binary.LittleEndian.Uint16(header[26:28])&0x3fff),
			uint64(binary.LittleEndian.Uint16(header[28:30])&0x3fff))
	case "VP8L":
		if chunkSize < 5 || len(header) < 25 || header[20] != 0x2f {
			return nil, nil, false, false, true
		}
		bits := binary.LittleEndian.Uint32(header[21:25])
		width, height = dimensions(uint64((bits&0x3fff)+1), uint64(((bits>>14)&0x3fff)+1))
	default:
		return nil, nil, false, false, true
	}
	if width == nil || height == nil {
		return nil, nil, animated, false, true
	}
	return width, height, animated, true, false
}

func little24(value []byte) uint32 {
	return uint32(value[0]) | uint32(value[1])<<8 | uint32(value[2])<<16
}

func looksLikeAVIF(header []byte) bool {
	if len(header) < 16 {
		return false
	}
	size, headerSize, ok := boxSize(header, 0, int64(len(header)))
	return ok && size >= uint64(headerSize+8) && size <= uint64(len(header)) && string(header[4:8]) == "ftyp" && avifBrands(header[headerSize:int(size)]) != 0
}

func avifMetadata(header []byte, totalBytes int64) (width, height *int, animated, previewSafe, malformed bool) {
	if totalBytes < 16 {
		return nil, nil, false, false, true
	}
	ftypSize, ftypHeader, ok := boxSize(header, 0, totalBytes)
	if !ok || ftypSize > uint64(len(header)) || ftypSize < uint64(ftypHeader+8) || string(header[4:8]) != "ftyp" {
		return nil, nil, false, false, true
	}
	brands := avifBrands(header[ftypHeader:int(ftypSize)])
	if brands == 0 {
		return nil, nil, false, false, true
	}
	animated = brands&2 != 0

	hasMeta, hasMedia := false, false
	for offset, boxes := int(ftypSize), 0; offset+8 <= len(header) && boxes < 4096; boxes++ {
		size, boxHeader, valid := boxSize(header, offset, totalBytes)
		if !valid {
			return nil, nil, animated, false, true
		}
		kind := string(header[offset+4 : offset+8])
		if kind == "mdat" {
			hasMedia = true
		}
		if kind == "meta" {
			hasMeta = true
			if size <= uint64(len(header)-offset) && size >= uint64(boxHeader+4) {
				width, height = findISPE(header[offset+boxHeader+4:offset+int(size)], 0, false)
			}
		}
		if width != nil && height != nil && hasMedia {
			break
		}
		if size > uint64(len(header)-offset) {
			break
		}
		offset += int(size)
	}
	if !hasMeta || !hasMedia || width == nil || height == nil {
		return width, height, animated, false, false
	}
	return width, height, animated, true, false
}

func avifBrands(body []byte) byte {
	if len(body) < 8 || (len(body)-8)%4 != 0 {
		return 0
	}
	var result byte
	for offset := 0; offset+4 <= len(body); offset += 4 {
		if offset == 4 {
			continue
		}
		switch string(body[offset : offset+4]) {
		case "avif":
			result |= 1
		case "avis":
			result |= 2
		}
	}
	return result
}

func findISPE(body []byte, depth int, insideProperties bool) (*int, *int) {
	if depth > maxBoxDepth {
		return nil, nil
	}
	for offset, boxes := 0, 0; offset+8 <= len(body) && boxes < 4096; boxes++ {
		size, headerSize, ok := boxSize(body, offset, int64(len(body)))
		if !ok || size > uint64(len(body)-offset) {
			return nil, nil
		}
		kind := string(body[offset+4 : offset+8])
		content := body[offset+headerSize : offset+int(size)]
		if kind == "ispe" && insideProperties && len(content) >= 12 {
			return dimensions(
				uint64(binary.BigEndian.Uint32(content[4:8])),
				uint64(binary.BigEndian.Uint32(content[8:12])))
		}
		switch kind {
		case "iprp", "ipco", "moov", "trak", "mdia", "minf", "stbl":
			if width, height := findISPE(content, depth+1, insideProperties || kind == "ipco"); width != nil {
				return width, height
			}
		}
		offset += int(size)
	}
	return nil, nil
}

func boxSize(body []byte, offset int, totalBytes int64) (uint64, int, bool) {
	if offset < 0 || offset+8 > len(body) || totalBytes < int64(offset+8) {
		return 0, 0, false
	}
	size := uint64(binary.BigEndian.Uint32(body[offset : offset+4]))
	headerSize := 8
	if size == 1 {
		if offset+16 > len(body) || totalBytes < int64(offset+16) {
			return 0, 0, false
		}
		size = binary.BigEndian.Uint64(body[offset+8 : offset+16])
		headerSize = 16
	} else if size == 0 {
		size = uint64(totalBytes - int64(offset))
	}
	return size, headerSize, size >= uint64(headerSize) && size <= uint64(totalBytes-int64(offset))
}

func dimensions(width, height uint64) (*int, *int) {
	if width == 0 || height == 0 || width > maxImageSide || height > maxImageSide {
		return nil, nil
	}
	w, h := int(width), int(height)
	return &w, &h
}

func looksLikeSVG(header []byte) bool {
	trimmed := bytes.TrimSpace(header)
	if len(trimmed) >= 3 && bytes.Equal(trimmed[:3], []byte{0xef, 0xbb, 0xbf}) {
		trimmed = bytes.TrimSpace(trimmed[3:])
	}
	lower := bytes.ToLower(trimmed[:min(len(trimmed), 512)])
	return bytes.HasPrefix(lower, []byte("<svg")) || bytes.HasPrefix(lower, []byte("<?xml")) && bytes.Contains(lower, []byte("<svg"))
}

func looksLikeText(header []byte) bool {
	if !utf8.Valid(header) {
		return false
	}
	for _, value := range header {
		if value == 0x7f || value < 0x20 && value != '\t' && value != '\n' && value != '\r' {
			return false
		}
	}
	return true
}

func HeaderLimit() int { return maxHeaderBytes }
