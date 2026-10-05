package exporter

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"codeberg.org/go-pdf/fpdf"
	"github.com/sianachi/Nix/apps/go-workers/internal/stream"
	"golang.org/x/image/font/gofont/gobold"
	"golang.org/x/image/font/gofont/gobolditalic"
	"golang.org/x/image/font/gofont/goitalic"
	"golang.org/x/image/font/gofont/gomono"
	"golang.org/x/image/font/gofont/goregular"
	"golang.org/x/image/font/sfnt"
)

const pdfMargin = 50.0
const pdfBottom = 792.0
const pdfWidth = 495.28
const maximumPDFPages = 1000

var pdfFont, _ = sfnt.Parse(goregular.TTF)

func pdfText(value string) string {
	var buffer sfnt.Buffer
	return strings.Map(func(r rune) rune {
		if r == '\n' || r == '\t' {
			return r
		}
		glyph, err := pdfFont.GlyphIndex(&buffer, r)
		if err != nil || glyph == 0 {
			return '?'
		}
		return r
	}, sanitizeText(value))
}

func PDFTextRequiresSubstitution(value string) bool { return pdfText(value) != sanitizeText(value) }

func writePDF(output io.Writer, next RecordSource, limits stream.Limits, report ReportSource) error {
	pdf := fpdf.New("P", "pt", "A4", "")
	pdf.SetCreationDate(time.Unix(0, 0).UTC())
	pdf.SetModificationDate(time.Unix(0, 0).UTC())
	pdf.SetCatalogSort(true)
	pdf.SetMargins(pdfMargin, pdfMargin, pdfMargin)
	pdf.SetAutoPageBreak(true, pdfMargin)
	pdf.SetAcceptPageBreakFunc(func() bool {
		if pdf.PageNo() >= maximumPDFPages {
			pdf.SetError(stream.ErrLimitExceeded)
			return false
		}
		return true
	})
	pdf.AddUTF8FontFromBytes("Nix", "", goregular.TTF)
	pdf.AddUTF8FontFromBytes("Nix", "B", gobold.TTF)
	pdf.AddUTF8FontFromBytes("Nix", "I", goitalic.TTF)
	pdf.AddUTF8FontFromBytes("Nix", "BI", gobolditalic.TTF)
	pdf.AddUTF8FontFromBytes("NixMono", "", gomono.TTF)
	pdf.SetFooterFunc(func() {
		pdf.SetY(-32)
		pdf.SetFont("Nix", "", 9)
		pdf.SetTextColor(100, 100, 100)
		pdf.CellFormat(pdfWidth, 12, fmt.Sprint(pdf.PageNo()), "", 0, "C", false, 0, "")
	})
	// The PDF library retains pages and raster resources until Output. Bound cumulative input
	// in addition to the output writer limit, rather than implying a streaming memory budget.
	records, remaining := 0, min(limits.MaxBytes, int64(32<<20))
	for {
		record, ok, err := next()
		if err != nil {
			return err
		}
		if !ok {
			break
		}
		records++
		if records > limits.MaxRecords {
			return stream.ErrLimitExceeded
		}
		if record.Title == "" {
			return errors.New("export record title is required")
		}
		remaining -= int64(len(record.Body) + len(record.Title))
		for _, raster := range record.Images {
			remaining -= int64(len(raster.Data))
		}
		if remaining < 0 {
			return stream.ErrLimitExceeded
		}
		addPDFPage(pdf)
		title, _ := ProjectTitle(record.Title, false)
		pdf.SetFont("Nix", "B", 24)
		pdf.SetTextColor(25, 25, 25)
		pdf.MultiCell(pdfWidth, 30, pdfText(title), "", "L", false)
		pdf.Ln(12)
		renderPDFMarkdown(pdf, record, records)
		if pdf.Error() != nil {
			return pdf.Error()
		}
	}
	if records == 0 {
		return errors.New("cannot export an empty PDF")
	}
	return pdf.Output(&limitedWriter{writer: output, remaining: limits.MaxBytes})
}

func addPDFPage(pdf *fpdf.Fpdf) {
	if pdf.PageNo() >= maximumPDFPages {
		pdf.SetError(stream.ErrLimitExceeded)
		return
	}
	pdf.AddPage()
}

func pdfSpace(pdf *fpdf.Fpdf, height float64) {
	if pdf.GetY()+height > pdfBottom {
		addPDFPage(pdf)
	}
}

func renderPDFMarkdown(pdf *fpdf.Fpdf, record stream.Record, recordIndex int) {
	lines := strings.Split(strings.ReplaceAll(record.Body, "\r\n", "\n"), "\n")
	code := false
	for index := 0; index < len(lines); index++ {
		if pdf.Error() != nil {
			return
		}
		line := lines[index]
		trimmed := strings.TrimSpace(line)
		pdf.SetFont("Nix", "", 11)
		pdf.SetTextColor(35, 35, 35)
		if strings.HasPrefix(trimmed, "```") {
			code = !code
			pdf.Ln(6)
			continue
		}
		if code {
			pdf.SetFont("NixMono", "", 10)
			pdf.SetFillColor(243, 244, 246)
			pdf.MultiCell(pdfWidth, 15, pdfText(line), "", "L", true)
			continue
		}
		if trimmed == "<!-- nix-page-break -->" {
			addPDFPage(pdf)
			continue
		}
		if trimmed == "<details>" || strings.HasPrefix(trimmed, `<details data-toggle-level=`) || trimmed == "</details>" {
			continue
		}
		if strings.HasPrefix(trimmed, "<summary>") {
			line = "**" + strings.TrimSuffix(strings.TrimPrefix(trimmed, "<summary>"), "</summary>") + "**"
			trimmed = line
		}
		if trimmed == "" {
			pdf.Ln(6)
			continue
		}
		if _, target, ok := blockImage(trimmed); ok {
			if raster := recordImage(record, target); ok && raster != nil {
				width, height := imageSize(*raster, pdfWidth, pdfBottom-pdfMargin)
				pdfSpace(pdf, height+8)
				name := fmt.Sprintf("image-%d-%d", recordIndex, index)
				options := fpdf.ImageOptions{ImageType: raster.Format, ReadDpi: false}
				pdf.RegisterImageOptionsReader(name, options, bytes.NewReader(raster.Data))
				y := pdf.GetY()
				pdf.ImageOptions(name, pdfMargin, y, width, height, false, options, 0, "")
				pdf.SetY(y + height + 8)
				continue
			}
		}
		if index+1 < len(lines) && strings.Contains(line, "|") && tableSeparator(lines[index+1]) {
			rows := [][]string{splitTableRow(line)}
			index++
			for index+1 < len(lines) && strings.Contains(lines[index+1], "|") && strings.TrimSpace(lines[index+1]) != "" {
				index++
				rows = append(rows, splitTableRow(lines[index]))
			}
			renderPDFTable(pdf, rows)
			continue
		}
		size, style, indent := 11.0, "", 0.0
		if level, body, ok := markdownHeading(line); ok {
			size = []float64{20, 17, 14, 13, 12, 11}[min(level-1, 5)]
			style = "B"
			line = body
			pdfSpace(pdf, size*2+22)
		} else if body, level, ok := markdownBullet(line); ok {
			indent = float64(min(level+1, 9)) * 14
			line = "• " + body
		} else if _, level, ok := markdownOrdered(line); ok {
			indent = float64(min(level+1, 9)) * 14
			line = strings.TrimSpace(line)
		} else if strings.HasPrefix(trimmed, ">") {
			indent = 16
			line = strings.TrimSpace(strings.TrimPrefix(trimmed, ">"))
			style = "I"
		}
		if trimmed == "---" || trimmed == "***" {
			pdfSpace(pdf, 12)
			pdf.SetDrawColor(190, 190, 190)
			pdf.Line(pdfMargin, pdf.GetY(), pdfMargin+pdfWidth, pdf.GetY())
			pdf.Ln(8)
			continue
		}
		pdf.SetLeftMargin(pdfMargin + indent)
		pdf.SetX(pdfMargin + indent)
		pdf.SetFont("Nix", style, size)
		pdfInline(pdf, line, 0, style, size)
		pdf.Ln(size * 1.45)
		pdf.SetLeftMargin(pdfMargin)
	}
}

func pdfInline(pdf *fpdf.Fpdf, value string, depth int, style string, size float64) {
	write := func(text string) { pdf.SetFont("Nix", style, size); pdf.Write(size*1.45, pdfText(text)) }
	if depth > 8 {
		write(unescapeMarkdown(value))
		return
	}
	for len(value) > 0 {
		if value[0] == '\\' && len(value) > 1 {
			write(value[1:2])
			value = value[2:]
			continue
		}
		if strings.HasPrefix(value, "![") {
			if label, _, rest, ok := markdownLink(value[1:]); ok {
				write("Image: " + unescapeMarkdown(label))
				value = rest
				continue
			}
		}
		if value[0] == '[' {
			if label, target, rest, ok := markdownLink(value); ok {
				pdf.SetFont("Nix", style, size)
				if safeDocumentLink(target) {
					pdf.WriteLinkString(size*1.45, pdfText(unescapeMarkdown(label)), target)
				} else {
					write(unescapeMarkdown(label))
				}
				value = rest
				continue
			}
		}
		matched := false
		for _, mark := range []struct{ token, style string }{{"**", "B"}, {"*", "I"}, {"~~", "S"}, {"`", "code"}} {
			if !strings.HasPrefix(value, mark.token) {
				continue
			}
			end := strings.Index(value[len(mark.token):], mark.token)
			if end < 0 {
				continue
			}
			end += len(mark.token)
			inner := value[len(mark.token):end]
			if mark.style == "code" {
				pdf.SetFont("NixMono", "", size)
				pdf.Write(size*1.45, pdfText(inner))
			} else {
				next := style
				if !strings.Contains(next, mark.style) {
					next += mark.style
				}
				pdfInline(pdf, inner, depth+1, next, size)
			}
			value = value[end+len(mark.token):]
			matched = true
			break
		}
		if matched {
			continue
		}
		length := nextMarkdownToken(value)
		if length == 0 {
			length = len(value)
		}
		write(unescapeMarkdown(value[:length]))
		value = value[length:]
	}
}

func renderPDFTable(pdf *fpdf.Fpdf, rows [][]string) {
	columns := len(rows[0])
	if columns == 0 {
		return
	}
	width := pdfWidth / float64(columns)
	for rowIndex, row := range rows {
		style := ""
		if rowIndex == 0 {
			style = "B"
		}
		pdf.SetFont("Nix", style, 10)
		cells := make([][]string, columns)
		count := 1
		for i := 0; i < columns; i++ {
			if i < len(row) {
				cells[i] = pdf.SplitText(pdfText(markdownPlainInline(row[i])), max(width-12, 1))
				count = max(count, len(cells[i]))
			}
		}
		// Split tall rows across pages at line boundaries so no cell can run below the footer.
		for start := 0; start < count; {
			if pdf.Error() != nil {
				return
			}
			pdfSpace(pdf, 22)
			take := min(count-start, max(1, int((pdfBottom-pdf.GetY()-8)/14)))
			height := float64(take)*14 + 8
			y := pdf.GetY()
			for i := 0; i < columns; i++ {
				x := pdfMargin + float64(i)*width
				pdf.SetDrawColor(205, 210, 215)
				pdf.SetFillColor(244, 246, 248)
				mode := "D"
				if rowIndex == 0 {
					mode = "FD"
				}
				pdf.Rect(x, y, width, height, mode)
				for n := 0; n < take && start+n < len(cells[i]); n++ {
					pdf.SetXY(x+6, y+4+float64(n)*14)
					pdf.CellFormat(width-12, 14, cells[i][start+n], "", 0, "L", false, 0, "")
				}
			}
			pdf.SetXY(pdfMargin, y+height)
			start += take
		}
	}
	pdf.Ln(8)
}

func markdownPlainInline(value string) string {
	var output strings.Builder
	output.Grow(len(value))
	for len(value) > 0 {
		if value[0] == '\\' && len(value) > 1 {
			output.WriteByte(value[1])
			value = value[2:]
			continue
		}
		if strings.HasPrefix(value, "![") {
			if label, _, rest, ok := markdownLink(value[1:]); ok {
				output.WriteString("Image: ")
				output.WriteString(unescapeMarkdown(label))
				value = rest
				continue
			}
		}
		if value[0] == '[' {
			if label, _, rest, ok := markdownLink(value); ok {
				output.WriteString(unescapeMarkdown(label))
				value = rest
				continue
			}
		}
		if strings.ContainsRune("*~`", rune(value[0])) {
			value = value[1:]
			continue
		}
		output.WriteByte(value[0])
		value = value[1:]
	}
	return sanitizeText(output.String())
}
