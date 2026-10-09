//go:build darwin || linux

package docsbrowser

import (
	"golang.org/x/sys/unix"
	"io"
)

func terminalSize(fd int) (int, int, error) {
	size, err := unix.IoctlGetWinsize(fd, unix.TIOCGWINSZ)
	if err != nil {
		return 0, 0, err
	}
	return int(size.Col), int(size.Row), nil
}
func readInput(fd int) ([]byte, error) {
	poll := []unix.PollFd{{Fd: int32(fd), Events: unix.POLLIN}}
	ready, err := unix.Poll(poll, 100)
	if err == unix.EINTR {
		return nil, nil
	}
	if err != nil || ready == 0 {
		return nil, err
	}
	buffer := make([]byte, 4096)
	n, err := unix.Read(fd, buffer)
	if err == unix.EINTR {
		return nil, nil
	}
	if n == 0 && err == nil {
		return nil, io.EOF
	}
	return buffer[:max(0, n)], err
}
