package importplan

import (
	"encoding/json"
	"testing"
)

func TestNixSchemaAcceptsNativeAssigneeType(t *testing.T) {
	schema := &nixSchemaSnapshot{
		Properties: json.RawMessage(`[ {"key":"assignee","type":"assignee"} ]`),
		Declared:   json.RawMessage(`[ {"key":"assignee","type":"assignee"} ]`),
	}
	if err := validateNixSchema(schema); err != nil {
		t.Fatalf("native assignee schema rejected: %v", err)
	}
}

func TestNixSchemaRejectsTypeOutsideBackendPropertyContract(t *testing.T) {
	schema := &nixSchemaSnapshot{
		Properties: json.RawMessage(`[ {"key":"assignee","type":"principal"} ]`),
		Declared:   json.RawMessage(`[]`),
	}
	if err := validateNixSchema(schema); err == nil {
		t.Fatal("unsupported property type accepted")
	}
}
