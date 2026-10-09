//go:build !darwin && !linux

package docsbrowser

import "errors"

func enterRaw(int) (func(), error) {
	return nil, errors.New("documentation TUI currently supports macOS and Linux; use list or read on this platform")
}
func terminalSize(int) (int, int, error) { return 0, 0, errors.New("unsupported terminal platform") }
func readInput(int) ([]byte, error)      { return nil, errors.New("unsupported terminal platform") }
