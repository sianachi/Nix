package worktemp

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const directoryName = "nix-go-workers"

var prefixes = []string{
	"nix-document-import-",
	"nix-export-",
	"nix-file-inspection-",
	"nix-import-stage-",
	"nix-pdf-pages-",
}

// Create opens a private spool file in the directory shared by worker processes on this host.
func Create(pattern string) (*os.File, error) {
	if !validPattern(pattern) {
		return nil, errors.New("worker temporary-file pattern is invalid")
	}
	directory, err := ensureDirectory()
	if err != nil {
		return nil, err
	}
	return os.CreateTemp(directory, pattern)
}

// Sweep removes only old regular spool files whose names belong to this package.
func Sweep(now time.Time, maximumAge time.Duration) error {
	if now.IsZero() || maximumAge <= 0 {
		return errors.New("worker temporary-file sweep configuration is invalid")
	}
	directory, err := ensureDirectory()
	if err != nil {
		return err
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		return err
	}
	cutoff := now.Add(-maximumAge)
	for _, entry := range entries {
		if entry.Type()&fs.ModeSymlink != 0 || entry.IsDir() || !ownedName(entry.Name()) {
			continue
		}
		info, infoErr := entry.Info()
		if infoErr != nil || !info.Mode().IsRegular() || !info.ModTime().Before(cutoff) {
			continue
		}
		if removeErr := os.Remove(filepath.Join(directory, entry.Name())); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
			return removeErr
		}
	}
	return nil
}

func ensureDirectory() (string, error) {
	directory := filepath.Join(os.TempDir(), directoryName)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return "", err
	}
	info, err := os.Lstat(directory)
	if err != nil {
		return "", err
	}
	if !info.IsDir() || info.Mode()&fs.ModeSymlink != 0 {
		return "", errors.New("worker temporary-file path is not a directory")
	}
	if err := os.Chmod(directory, 0o700); err != nil {
		return "", err
	}
	return directory, nil
}

func validPattern(pattern string) bool {
	return strings.HasSuffix(pattern, "*") && ownedName(strings.TrimSuffix(pattern, "*"))
}

func ownedName(name string) bool {
	for _, prefix := range prefixes {
		if strings.HasPrefix(name, prefix) {
			return true
		}
	}
	return false
}
