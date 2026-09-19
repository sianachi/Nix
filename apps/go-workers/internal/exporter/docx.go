package exporter

import (
	"archive/zip"
	"errors"
	"fmt"
	"html"
	"io"
	"net/url"
	"os"
	"strconv"
	"strings"

	"github.com/sianachi/Nix/apps/go-workers/internal/stream"
	"github.com/sianachi/Nix/apps/go-workers/internal/worktemp"
)

const docxContentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>`
const docxRootRelationships = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`
const docxDocumentRelationships = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>`
const docxStyles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="44"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="360"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="360"/></w:pPr></w:style></w:styles>`

func writeDOCX(output io.Writer, next RecordSource, limits stream.Limits, report ReportSource) error {
	limited := &limitedWriter{writer: output, remaining: limits.MaxBytes}
	archive := zip.NewWriter(limited)
	entries := []struct{ name, body string }{
		{"[Content_Types].xml", docxContentTypes},
		{"_rels/.rels", docxRootRelationships},

		{"word/styles.xml", docxStyles},
		{"word/numbering.xml", docxNumberingXML()},
	}
	for _, entry := range entries {
		if err := writeZipEntry(archive, entry.name, []byte(entry.body), limits); err != nil {
			return err
		}
	}
	document, err := worktemp.Create("nix-export-docx-*")
	if err != nil {
		return err
	}
	defer func() { document.Close(); os.Remove(document.Name()) }()
	var media []struct {
		name string
		data []byte
	}
	imageID := 0
	relationships := strings.TrimSuffix(docxDocumentRelationships, "</Relationships>")
	if _, err := io.WriteString(document, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>`); err != nil {
		return err
	}
	records := 0
	err = eachRecord(next, limits.MaxRecords, func(record stream.Record) error {
		if record.Title == "" {
			return errors.New("export record title is required")
		}
		records++
		title, _ := ProjectTitle(record.Title, false)
		if err := writeDOCXParagraph(document, title, docxParagraph{style: "Title", pageBreakBefore: records > 1}); err != nil {
			return err
		}
		// Flush each note's prose and images without retaining image bytes across records.
		if err := writeDOCXMarkdownImages(document, record, func(raster stream.Image, alt string) error {
			imageID++
			name := fmt.Sprintf("media/image%d.%s", imageID, raster.Format)
			rel := fmt.Sprintf("rImage%d", imageID)
			relationships += `<Relationship Id="` + rel + `" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="` + name + `"/>`
			media = append(media, struct {
				name string
				data []byte
			}{name, raster.Data})
			return writeDOCXImage(document, raster, alt, rel, imageID)
		}); err != nil {
			return err
		}
		for _, image := range media {
			entry, err := createZipEntry(archive, "word/"+image.name)
			if err != nil {
				return err
			}
			if _, err := entry.Write(image.data); err != nil {
				return err
			}
		}
		media = nil
		if stat, err := document.Stat(); err != nil {
			return err
		} else if stat.Size() > limits.MaxBytes {
			return stream.ErrLimitExceeded
		}
		return nil
	}, limited)
	if err != nil {
		return err
	}
	if records == 0 {
		return errors.New("cannot export an empty DOCX")
	}
	if _, err := io.WriteString(document, `<w:sectPr/></w:body></w:document>`); err != nil {
		return err
	}
	if _, err := document.Seek(0, io.SeekStart); err != nil {
		return err
	}
	entry, err := createZipEntry(archive, "word/document.xml")
	if err != nil {
		return err
	}
	if _, err := io.Copy(entry, document); err != nil {
		return err
	}
	if err := writeZipEntry(archive, "word/_rels/document.xml.rels", []byte(relationships+"</Relationships>"), limits); err != nil {
		return err
	}
	if err := archive.Close(); err != nil {
		return err
	}
	return limited.err
}

func docxNumberingXML() string {
	var output strings.Builder
	output.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">`)
	for abstractID := 1; abstractID <= 2; abstractID++ {
		output.WriteString(`<w:abstractNum w:abstractNumId="` + strconv.Itoa(abstractID) + `"><w:multiLevelType w:val="multilevel"/>`)
		for level := 0; level <= 8; level++ {
			format, marker := "bullet", "-"
			if abstractID == 2 {
				format = "decimal"
				marker = "%" + strconv.Itoa(level+1) + "."
			}
			output.WriteString(`<w:lvl w:ilvl="` + strconv.Itoa(level) + `"><w:start w:val="1"/><w:numFmt w:val="` + format + `"/><w:lvlText w:val="` + marker + `"/><w:pPr><w:ind w:left="` + strconv.Itoa((level+1)*360) + `" w:hanging="260"/></w:pPr></w:lvl>`)
		}
		output.WriteString(`</w:abstractNum>`)
	}
	output.WriteString(`<w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="2"/></w:num></w:numbering>`)
	return output.String()
}

type docxParagraph struct {
	style           string
	numbering       int
	level           int
	pageBreakBefore bool
	plain           bool
}

func writeDOCXParagraph(output io.Writer, text string, options docxParagraph) error {
	if _, err := io.WriteString(output, `<w:p>`); err != nil {
		return err
	}
	if options.style != "" || options.numbering != 0 || options.pageBreakBefore {
		if _, err := io.WriteString(output, `<w:pPr>`); err != nil {
			return err
		}
		if options.style != "" {
			if _, err := io.WriteString(output, `<w:pStyle w:val="`+html.EscapeString(options.style)+`"/>`); err != nil {
				return err
			}
		}
		if options.numbering != 0 {
			level := min(max(options.level, 0), 8)
			if _, err := io.WriteString(output, `<w:numPr><w:ilvl w:val="`+strconv.Itoa(level)+`"/><w:numId w:val="`+strconv.Itoa(options.numbering)+`"/></w:numPr>`); err != nil {
				return err
			}
		}
		if options.pageBreakBefore {
			if _, err := io.WriteString(output, `<w:pageBreakBefore/>`); err != nil {
				return err
			}
		}
		if _, err := io.WriteString(output, `</w:pPr>`); err != nil {
			return err
		}
	}
	if options.plain {
		if err := writeDOCXRun(output, text, inlineStyle{}); err != nil {
			return err
		}
	} else if err := writeDOCXInline(output, text, 0, inlineStyle{}); err != nil {
		return err
	}
	_, err := io.WriteString(output, `</w:p>`)
	return err
}

func writeDOCXMarkdown(output io.Writer, markdown string) error {
	lines := strings.Split(strings.ReplaceAll(markdown, "\r\n", "\n"), "\n")
	inCode := false
	for index := 0; index < len(lines); index++ {
		line := strings.TrimSuffix(lines[index], "\r")
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "```") {
			inCode = !inCode
			continue
		}
		if inCode {
			if err := writeDOCXParagraph(output, sanitizeText(line), docxParagraph{style: "Code", plain: true}); err != nil {
				return err
			}
			continue
		}
		if trimmed == "<!-- nix-page-break -->" {
			if _, err := io.WriteString(output, `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`); err != nil {
				return err
			}
			continue
		}
		if trimmed == "" || trimmed == "<details>" || strings.HasPrefix(trimmed, `<details data-toggle-level=`) || trimmed == "</details>" {
			continue
		}
		if strings.HasPrefix(trimmed, "<summary>") && strings.HasSuffix(trimmed, "</summary>") {
			trimmed = strings.TrimSuffix(strings.TrimPrefix(trimmed, "<summary>"), "</summary>")
			if err := writeDOCXParagraph(output, trimmed, docxParagraph{style: "Heading3"}); err != nil {
				return err
			}
			continue
		}
		if index+1 < len(lines) && strings.Contains(line, "|") && tableSeparator(lines[index+1]) {
			end := index + 2
			for end < len(lines) && strings.Contains(lines[end], "|") && strings.TrimSpace(lines[end]) != "" {
				end++
			}
			if err := writeDOCXTable(output, append([]string{line}, lines[index+2:end]...)); err != nil {
				return err
			}
			index = end - 1
			continue
		}
		if level, body, ok := markdownHeading(line); ok {
			if err := writeDOCXParagraph(output, body, docxParagraph{style: "Heading" + strconv.Itoa(min(level, 3))}); err != nil {
				return err
			}
			continue
		}
		if body, level, ok := markdownBullet(line); ok {
			if err := writeDOCXParagraph(output, body, docxParagraph{numbering: 1, level: level}); err != nil {
				return err
			}
			continue
		}
		if body, level, ok := markdownOrdered(line); ok {
			if err := writeDOCXParagraph(output, body, docxParagraph{numbering: 2, level: level}); err != nil {
				return err
			}
			continue
		}
		if strings.HasPrefix(trimmed, ">") {
			body := strings.TrimSpace(strings.TrimPrefix(trimmed, ">"))
			if err := writeDOCXParagraph(output, body, docxParagraph{style: "Quote"}); err != nil {
				return err
			}
			continue
		}
		if trimmed == "---" || trimmed == "***" {
			if err := writeDOCXParagraph(output, "", docxParagraph{}); err != nil {
				return err
			}
			continue
		}
		if err := writeDOCXParagraph(output, line, docxParagraph{}); err != nil {
			return err
		}
	}
	return nil
}

func writeDOCXTable(output io.Writer, rows []string) error {
	if _, err := io.WriteString(output, `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr>`); err != nil {
		return err
	}
	for _, row := range rows {
		if _, err := io.WriteString(output, `<w:tr>`); err != nil {
			return err
		}
		for _, cell := range splitTableRow(row) {
			if _, err := io.WriteString(output, `<w:tc>`); err != nil {
				return err
			}
			if err := writeDOCXParagraph(output, cell, docxParagraph{}); err != nil {
				return err
			}
			if _, err := io.WriteString(output, `</w:tc>`); err != nil {
				return err
			}
		}
		if _, err := io.WriteString(output, `</w:tr>`); err != nil {
			return err
		}
	}
	_, err := io.WriteString(output, `</w:tbl>`)
	return err
}

type inlineStyle struct {
	bold, italic, strike, code bool
}

func writeDOCXInline(output io.Writer, value string, depth int, style inlineStyle) error {
	if depth > 8 {
		return writeDOCXRun(output, unescapeMarkdown(value), style)
	}
	for len(value) > 0 {
		if value[0] == '\\' && len(value) > 1 {
			if err := writeDOCXRun(output, value[1:2], style); err != nil {
				return err
			}
			value = value[2:]
			continue
		}
		if strings.HasPrefix(value, "![") {
			if label, target, rest, ok := markdownLink(value[1:]); ok {
				if err := writeDOCXLink(output, "Image: "+label, target, style); err != nil {
					return err
				}
				value = rest
				continue
			}
		}
		if value[0] == '[' {
			if label, target, rest, ok := markdownLink(value); ok {
				if err := writeDOCXLink(output, label, target, style); err != nil {
					return err
				}
				value = rest
				continue
			}
		}
		matched := false
		for _, mark := range []struct {
			token string
			apply func(*inlineStyle)
		}{
			{"**", func(next *inlineStyle) { next.bold = true }},
			{"~~", func(next *inlineStyle) { next.strike = true }},
			{"*", func(next *inlineStyle) { next.italic = true }},
			{"`", func(next *inlineStyle) { next.code = true }},
		} {
			if !strings.HasPrefix(value, mark.token) {
				continue
			}
			end := strings.Index(value[len(mark.token):], mark.token)
			if end < 0 {
				continue
			}
			end += len(mark.token)
			nextStyle := style
			mark.apply(&nextStyle)
			if err := writeDOCXInline(output, value[len(mark.token):end], depth+1, nextStyle); err != nil {
				return err
			}
			value = value[end+len(mark.token):]
			matched = true
			break
		}
		if matched {
			continue
		}
		next := nextMarkdownToken(value)
		if next == 0 {
			next = len(value)
		}
		if err := writeDOCXRun(output, unescapeMarkdown(value[:next]), style); err != nil {
			return err
		}
		value = value[next:]
	}
	return nil
}

func writeDOCXRun(output io.Writer, value string, style inlineStyle) error {
	value = sanitizeText(value)
	if value == "" {
		return nil
	}
	if _, err := io.WriteString(output, `<w:r>`); err != nil {
		return err
	}
	if style.bold || style.italic || style.strike || style.code {
		if _, err := io.WriteString(output, `<w:rPr>`); err != nil {
			return err
		}
		if style.bold {
			if _, err := io.WriteString(output, `<w:b/>`); err != nil {
				return err
			}
		}
		if style.italic {
			if _, err := io.WriteString(output, `<w:i/>`); err != nil {
				return err
			}
		}
		if style.strike {
			if _, err := io.WriteString(output, `<w:strike/>`); err != nil {
				return err
			}
		}
		if style.code {
			if _, err := io.WriteString(output, `<w:shd w:val="clear" w:fill="EDEDED"/>`); err != nil {
				return err
			}
		}
		if _, err := io.WriteString(output, `</w:rPr>`); err != nil {
			return err
		}
	}
	_, err := io.WriteString(output, `<w:t xml:space="preserve">`+html.EscapeString(value)+`</w:t></w:r>`)
	return err
}

func writeDOCXLink(output io.Writer, label, target string, style inlineStyle) error {
	if !safeDocumentLink(target) {
		return writeDOCXRun(output, unescapeMarkdown(label), style)
	}
	instruction := html.EscapeString(` HYPERLINK "` + target + `" `)
	if _, err := io.WriteString(output, `<w:fldSimple w:instr="`+instruction+`">`); err != nil {
		return err
	}
	if err := writeDOCXRun(output, unescapeMarkdown(label), style); err != nil {
		return err
	}
	_, err := io.WriteString(output, `</w:fldSimple>`)
	return err
}

func safeDocumentLink(raw string) bool {
	if len(raw) == 0 || len(raw) > 2048 || strings.ContainsAny(raw, "\r\n\x00\"\\") {
		return false
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.User != nil {
		return false
	}
	return oneOf(strings.ToLower(parsed.Scheme), "http", "https", "mailto", "nix")
}

func markdownLink(value string) (string, string, string, bool) {
	if !strings.HasPrefix(value, "[") {
		return "", "", value, false
	}
	closeLabel := -1
	for index := 1; index+1 < len(value); index++ {
		if value[index] == '\\' && index+1 < len(value) {
			index++
			continue
		}
		if value[index] == ']' && value[index+1] == '(' {
			closeLabel = index
			break
		}
	}
	if closeLabel < 1 {
		return "", "", value, false
	}
	targetStart := closeLabel + 2
	closeTarget := -1
	inAngle, inTitle := false, false
	for index := targetStart; index < len(value); index++ {
		if value[index] == '\\' && index+1 < len(value) {
			index++
			continue
		}
		switch value[index] {
		case '<':
			if !inTitle {
				inAngle = true
			}
		case '>':
			if !inTitle {
				inAngle = false
			}
		case '"':
			if !inAngle {
				inTitle = !inTitle
			}
		case ')':
			if !inAngle && !inTitle {
				closeTarget = index
			}
		}
		if closeTarget >= 0 {
			break
		}
	}
	if closeTarget < 0 {
		return "", "", value, false
	}
	rawTarget := strings.TrimSpace(value[targetStart:closeTarget])
	if rawTarget == "" {
		return "", "", value, false
	}
	if rawTarget[0] == '<' {
		end := -1
		for index := 1; index < len(rawTarget); index++ {
			if rawTarget[index] == '\\' && index+1 < len(rawTarget) {
				index++
				continue
			}
			if rawTarget[index] == '>' {
				end = index
				break
			}
		}
		if end < 0 {
			return "", "", value, false
		}
		rawTarget = rawTarget[1:end]
	} else {
		for index := 0; index < len(rawTarget); index++ {
			if rawTarget[index] == '\\' && index+1 < len(rawTarget) {
				index++
				continue
			}
			if rawTarget[index] == ' ' || rawTarget[index] == '\t' {
				rawTarget = rawTarget[:index]
				break
			}
		}
	}
	return value[1:closeLabel], unescapeMarkdown(rawTarget), value[closeTarget+1:], true
}

func nextMarkdownToken(value string) int {
	for index := 1; index < len(value); index++ {
		if strings.ContainsRune(`\\*![`+"`~", rune(value[index])) {
			return index
		}
	}
	return 0
}

func unescapeMarkdown(value string) string {
	var output strings.Builder
	output.Grow(len(value))
	for index := 0; index < len(value); index++ {
		if value[index] == '\\' && index+1 < len(value) {
			index++
		}
		output.WriteByte(value[index])
	}
	return output.String()
}

func markdownHeading(line string) (int, string, bool) {
	trimmed := strings.TrimLeft(line, " \t")
	level := 0
	for level < len(trimmed) && level < 6 && trimmed[level] == '#' {
		level++
	}
	if level == 0 || level >= len(trimmed) || trimmed[level] != ' ' {
		return 0, "", false
	}
	return level, strings.TrimSpace(trimmed[level+1:]), true
}

func markdownBullet(line string) (string, int, bool) {
	trimmed := strings.TrimLeft(line, " \t")
	indent := len(line) - len(trimmed)
	if len(trimmed) < 2 || !strings.ContainsRune("-*+", rune(trimmed[0])) || trimmed[1] != ' ' {
		return "", 0, false
	}
	return strings.TrimSpace(trimmed[2:]), min(indent/2, 8), true
}

func markdownOrdered(line string) (string, int, bool) {
	trimmed := strings.TrimLeft(line, " \t")
	indent := len(line) - len(trimmed)
	index := 0
	for index < len(trimmed) && trimmed[index] >= '0' && trimmed[index] <= '9' {
		index++
	}
	if index == 0 || index+1 >= len(trimmed) || trimmed[index] != '.' || trimmed[index+1] != ' ' {
		return "", 0, false
	}
	return strings.TrimSpace(trimmed[index+2:]), min(indent/2, 8), true
}

func tableSeparator(line string) bool {
	cells := splitTableRow(line)
	if len(cells) == 0 {
		return false
	}
	for _, cell := range cells {
		cell = strings.Trim(strings.TrimSpace(cell), ":")
		if len(cell) < 3 || strings.Trim(cell, "-") != "" {
			return false
		}
	}
	return true
}

func splitTableRow(line string) []string {
	line = strings.TrimSpace(line)
	line = strings.TrimPrefix(line, "|")
	line = strings.TrimSuffix(line, "|")
	var cells []string
	start := 0
	escaped := false
	for index := 0; index < len(line); index++ {
		if escaped {
			escaped = false
			continue
		}
		if line[index] == '\\' {
			escaped = true
			continue
		}
		if line[index] == '|' {
			cells = append(cells, strings.TrimSpace(unescapeMarkdown(line[start:index])))
			start = index + 1
		}
	}
	cells = append(cells, strings.TrimSpace(unescapeMarkdown(line[start:])))
	return cells
}

func writeDOCXMarkdownImages(output io.Writer, record stream.Record, embed func(stream.Image, string) error) error {
	// Images are block nodes. Keep intervening Markdown together so tables and lists still parse.
	var pending strings.Builder
	flush := func() error { err := writeDOCXMarkdown(output, pending.String()); pending.Reset(); return err }
	for _, line := range strings.Split(record.Body, "\n") {
		trimmed := strings.TrimSpace(line)
		if alt, target, ok := blockImage(trimmed); ok {
			if raster := recordImage(record, target); ok && raster != nil {
				if pending.Len() > 0 {
					if err := flush(); err != nil {
						return err
					}
				}
				if err := embed(*raster, unescapeMarkdown(alt)); err != nil {
					return err
				}
				continue
			}
		}
		pending.WriteString(line)
		pending.WriteByte('\n')
	}
	if pending.Len() > 0 {
		return flush()
	}
	return nil
}

func writeDOCXImage(output io.Writer, raster stream.Image, alt, rel string, id int) error {
	width, height := imageSize(raster, 468, 648)
	cx, cy := int64(width*12700), int64(height*12700)
	_, err := fmt.Fprintf(output, `<w:p><w:r><w:drawing><wp:inline><wp:extent cx="%d" cy="%d"/><wp:docPr id="%d" name="Image %d" descr="%s"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="%d" name="Image %d"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="%s"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="%d" cy="%d"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`, cx, cy, id, id, html.EscapeString(alt), id, id, rel, cx, cy)
	return err
}
