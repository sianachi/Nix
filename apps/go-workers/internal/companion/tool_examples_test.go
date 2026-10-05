package companion

import (
	_ "embed"
	"encoding/json"
	"fmt"
)

// tool-examples.json is only ever read by this package's own tests (TestFlattenToolCallMatch-
// esTSReferenceFixture and TestFlattenedFixturesAreAcceptedByValidateToolArguments, tools_test.go),
// never by production code, so its embed and parsing live in a _test.go file rather than
// catalog.go.
//
//go:embed catalog/tool-examples.json
var toolExamplesJSON []byte

// toolExampleFixture is one entry of the embedded tool-examples.json: a valid typed-tool
// argument object for one operation, and the flat {operation, itemId, ...} shape
// flattenToolCall must produce from it. Written by the same generator
// (scripts/build-catalog.ts) that TS's own tools.test.ts checks its flattening reference
// implementation against, so TestFlattenToolCallMatchesTSReferenceFixture (tools_test.go) and
// the TS round trip check the identical fixture.
type toolExampleFixture struct {
	Operation string          `json:"operation"`
	Arguments json.RawMessage `json:"arguments"`
	Flat      flatToolArgs    `json:"flat"`
}

var toolExamples []toolExampleFixture

func init() {
	if err := json.Unmarshal(toolExamplesJSON, &toolExamples); err != nil {
		panic(fmt.Sprintf("catalog/tool-examples.json is invalid: %v", err))
	}
}
