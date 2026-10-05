//go:build linux

package speechcmd

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
)

func bounded(ctx context.Context, limits Limits, name string, arguments ...string) (*exec.Cmd, error) {
	prlimit, err := exec.LookPath("prlimit")
	if err != nil {
		return nil, errors.New("prlimit is required to bound speech commands")
	}
	prefix := []string{
		fmt.Sprintf("--as=%d", limits.MemoryBytes),
		fmt.Sprintf("--cpu=%d", limits.CPUSeconds),
		"--",
		name,
	}
	command := exec.CommandContext(ctx, prlimit, append(prefix, arguments...)...)
	command.Env = Environment()
	return command, nil
}
