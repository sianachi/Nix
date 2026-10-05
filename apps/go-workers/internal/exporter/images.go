package exporter

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	_ "image/jpeg"
	"image/png"
	"strings"

	"github.com/sianachi/Nix/apps/go-workers/internal/stream"
	_ "golang.org/x/image/webp"
)

// ImageLoader is supplied by the job host; projection itself has no network authority.
type ImageLoader func(fileID string) ([]byte, error)

// ProjectBodyWithImages preserves supported file images in a bounded per-record resource set.
func ProjectBodyWithImages(body json.RawMessage, maximumBytes int, load ImageLoader) (string, []stream.Image, []string, error) {
	if maximumBytes <= 0 {
		return "", nil, nil, errors.New("prose projection limit must be positive")
	}
	if load == nil {
		load = func(string) ([]byte, error) { return nil, errors.New("image loader unavailable") }
	}
	if len(body) == 0 || bytes.Equal(bytes.TrimSpace(body), []byte("null")) {
		text, losses, err := ProjectBody(body, true, maximumBytes)
		return text, nil, losses, err
	}
	decoded, err := decodeProseBody(body, proseAllocationLimit(len(body), maximumBytes))
	if err != nil {
		return "", nil, nil, err
	}
	if decoded.root == nil || decoded.schemaVersion < 1 {
		text, losses, err := ProjectBody(body, true, maximumBytes)
		return text, nil, losses, err
	}
	projection := proseProjection{markdown: true, writer: newProseWriter(maximumBytes), losses: make(map[string]struct{})}
	var images []stream.Image
	remaining := 32 << 20
	var visit func(*proseNode) error
	visit = func(node *proseNode) error {
		if (node.Type == "image" || node.Type == "fileImage") && node.Attrs.fileID != "" {
			if len(images) >= 64 || remaining <= 0 {
				return stream.ErrLimitExceeded
			}
			data, err := load(node.Attrs.fileID)
			if err == nil && len(data) > remaining {
				return stream.ErrLimitExceeded
			}
			var raster stream.Image
			if err == nil {
				raster, err = validatedImage(data)
			}
			if err != nil {
				projection.noteLoss("An unavailable or unsupported image was represented by its description.")
				node.Attrs.source = ""
			} else {
				if len(raster.Data) > remaining {
					return stream.ErrLimitExceeded
				}
				remaining -= len(raster.Data)
				raster.Source = fmt.Sprintf("https://nix.invalid/export-image/%d/resource", len(images))
				raster.Width = node.Attrs.width
				node.Attrs.source = raster.Source
				node.Attrs.dimensions = false
				images = append(images, raster)
			}
		}
		for index := range node.Content {
			if err := visit(&node.Content[index]); err != nil {
				return err
			}
		}
		return nil
	}
	if err := visit(decoded.root); err != nil {
		return "", nil, nil, err
	}
	if err := projection.render(decoded.root, 0); err != nil {
		return "", nil, nil, err
	}
	return strings.TrimSpace(projection.writer.String()), images, projection.lossList, nil
}

func validatedImage(data []byte) (stream.Image, error) {
	if len(data) == 0 || len(data) > 10<<20 {
		return stream.Image{}, errors.New("image byte limit exceeded")
	}
	config, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || config.Width <= 0 || config.Height <= 0 || int64(config.Width)*int64(config.Height) > 40_000_000 {
		return stream.Image{}, errors.New("invalid or oversized raster image")
	}
	if format != "png" && format != "jpeg" && format != "webp" {
		return stream.Image{}, errors.New("unsupported image format")
	}
	// Decode before passing bytes to the document libraries. WebP is normalized to PNG.
	decoded, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return stream.Image{}, err
	}
	if format == "webp" {
		var output bytes.Buffer
		limited := &limitedWriter{writer: &output, remaining: 10 << 20}
		if err := png.Encode(limited, decoded); err != nil {
			return stream.Image{}, err
		}
		data, format = output.Bytes(), "png"
	}
	return stream.Image{Data: data, Format: format, PixelWidth: config.Width, PixelHeight: config.Height}, nil
}

func recordImage(record stream.Record, target string) *stream.Image {
	for index := range record.Images {
		if record.Images[index].Source == target {
			return &record.Images[index]
		}
	}
	return nil
}

func imageSize(raster stream.Image, maxWidth, maxHeight float64) (float64, float64) {
	width := float64(raster.PixelWidth) * 0.75
	if raster.Width > 0 {
		width = float64(raster.Width) * 0.75
	}
	width = min(width, maxWidth)
	height := width * float64(raster.PixelHeight) / float64(raster.PixelWidth)
	if height > maxHeight {
		width *= maxHeight / height
		height = maxHeight
	}
	return width, height
}

// Projected block images may carry a quote or list prefix.
func blockImage(value string) (string, string, bool) {
	value = strings.TrimSpace(value)
	for strings.HasPrefix(value, ">") {
		value = strings.TrimSpace(strings.TrimPrefix(value, ">"))
	}
	if body, _, ok := markdownBullet(value); ok {
		value = body
	} else if body, _, ok := markdownOrdered(value); ok {
		value = body
	}
	if !strings.HasPrefix(value, "![") {
		return "", "", false
	}
	alt, target, rest, ok := markdownLink(value[1:])
	return alt, target, ok && strings.TrimSpace(rest) == ""
}
