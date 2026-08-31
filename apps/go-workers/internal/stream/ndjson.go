package stream

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

var ErrLimitExceeded = errors.New("stream limit exceeded")

type Record struct {
	ID         string         `json:"id"`
	ParentID   string         `json:"parentId,omitempty"`
	Title      string         `json:"title"`
	Body       string         `json:"body,omitempty"`
	Properties map[string]any `json:"properties,omitempty"`
}

type Limits struct {
	MaxBytes   int64
	MaxLine    int
	MaxRecords int
}

type Summary struct {
	Records int   `json:"records"`
	Bytes   int64 `json:"bytes"`
}

func ReadRecords(reader io.Reader, limits Limits, visit func(Record) error) (Summary, error) {
	if limits.MaxBytes <= 0 || limits.MaxLine <= 0 || limits.MaxRecords <= 0 {
		return Summary{}, fmt.Errorf("stream limits must be positive")
	}
	scanner := bufio.NewScanner(io.LimitReader(reader, limits.MaxBytes+1))
	initialBuffer := limits.MaxLine
	if initialBuffer > 64*1024 {
		initialBuffer = 64 * 1024
	}
	scanner.Buffer(make([]byte, initialBuffer), limits.MaxLine)
	var summary Summary
	for scanner.Scan() {
		line := scanner.Bytes()
		summary.Bytes += int64(len(line)) + 1
		if summary.Bytes > limits.MaxBytes {
			return summary, ErrLimitExceeded
		}
		if summary.Records >= limits.MaxRecords {
			return summary, ErrLimitExceeded
		}
		var record Record
		if err := json.Unmarshal(line, &record); err != nil {
			return summary, fmt.Errorf("record %d is not valid JSON: %w", summary.Records+1, err)
		}
		if record.ID == "" || record.Title == "" {
			return summary, fmt.Errorf("record %d must contain id and title", summary.Records+1)
		}
		if err := visit(record); err != nil {
			return summary, err
		}
		summary.Records++
	}
	if err := scanner.Err(); err != nil {
		if errors.Is(err, bufio.ErrTooLong) {
			return summary, ErrLimitExceeded
		}
		return summary, err
	}
	return summary, nil
}

func WriteRecords(writer io.Writer, records []Record, limits Limits) (Summary, error) {
	if len(records) > limits.MaxRecords {
		return Summary{}, ErrLimitExceeded
	}
	encoder := json.NewEncoder(writer)
	var summary Summary
	for index, record := range records {
		if record.ID == "" || record.Title == "" {
			return summary, fmt.Errorf("record %d must contain id and title", index+1)
		}
		line, err := json.Marshal(record)
		if err != nil {
			return summary, fmt.Errorf("record %d cannot be encoded: %w", index+1, err)
		}
		if len(line)+1 > limits.MaxLine || summary.Bytes+int64(len(line)+1) > limits.MaxBytes {
			return summary, ErrLimitExceeded
		}
		if err := encoder.Encode(record); err != nil {
			return summary, err
		}
		summary.Records++
		summary.Bytes += int64(len(line) + 1)
	}
	return summary, nil
}
