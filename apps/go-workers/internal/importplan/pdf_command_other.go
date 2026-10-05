//go:build !linux

package importplan

import (
	"context"
	"errors"
	"os/exec"
)

func newPDFTextCommand(ctx context.Context, sourcePath string, cpuSeconds int, memoryBytes int64) (*exec.Cmd, error) {
	if cpuSeconds <= 0 || memoryBytes <= 0 {
		return nil, errors.New("PDF process limits are invalid")
	}
	return exec.CommandContext(ctx, "pdftotext", "-layout", "-enc", "UTF-8", sourcePath, "-"), nil
}
