//go:build !linux

package speechcmd

import (
	"context"
	"os/exec"
)

func bounded(ctx context.Context, _ Limits, name string, arguments ...string) (*exec.Cmd, error) {
	command := exec.CommandContext(ctx, name, arguments...)
	command.Env = Environment()
	return command, nil
}
