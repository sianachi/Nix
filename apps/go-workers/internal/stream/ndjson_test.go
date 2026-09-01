package stream

import (
	"errors"
	"strings"
	"testing"
)

func TestReadRecordsStreamsAndCountsBoundedInput(t *testing.T) {
	input := `{"id":"one","title":"One"}
{"id":"two","title":"Two","parentId":"one"}
`
	var ids []string
	summary, err := ReadRecords(strings.NewReader(input), Limits{MaxBytes: 1000, MaxLine: 100, MaxRecords: 10}, func(record Record) error {
		ids = append(ids, record.ID)
		return nil
	})
	if err != nil {
		t.Fatalf("ReadRecords() error = %v", err)
	}
	if len(ids) != 2 || summary.Records != 2 {
		t.Fatalf("unexpected result: ids=%v summary=%+v", ids, summary)
	}
}

func TestReadRecordsRefusesOversizedInput(t *testing.T) {
	_, err := ReadRecords(strings.NewReader(`{"id":"one","title":"One"}`), Limits{MaxBytes: 5, MaxLine: 100, MaxRecords: 10}, func(Record) error { return nil })
	if !errors.Is(err, ErrLimitExceeded) {
		t.Fatalf("ReadRecords() error = %v, want ErrLimitExceeded", err)
	}
}

func TestWriteRecordsRefusesMissingIdentity(t *testing.T) {
	var output strings.Builder
	_, err := WriteRecords(&output, []Record{{Title: "missing id"}}, Limits{MaxBytes: 100, MaxLine: 100, MaxRecords: 10})
	if err == nil {
		t.Fatal("WriteRecords() unexpectedly accepted a record without an id")
	}
}
