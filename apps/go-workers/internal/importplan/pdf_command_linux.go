//go:build linux

package importplan

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
)

func newPDFTextCommand(ctx context.Context, sourcePath string, cpuSeconds int, memoryBytes int64) (*exec.Cmd, error) {
	if cpuSeconds <= 0 || memoryBytes <= 0 {
		return nil, errors.New("PDF process limits are invalid")
	}
	prlimit, err := exec.LookPath("prlimit")
	if err != nil {
		return nil, errors.New("prlimit is required to isolate PDF extraction")
	}
	return exec.CommandContext(
		ctx,
		prlimit,
		fmt.Sprintf("--as=%d", memoryBytes),
		fmt.Sprintf("--cpu=%d", cpuSeconds),
		"--",
		"pdftotext",
		"-layout",
		"-enc",
		"UTF-8",
		sourcePath,
		"-",
	), nil
}
