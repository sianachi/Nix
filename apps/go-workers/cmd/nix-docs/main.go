package main

import (
	"fmt"
	"os"

	"github.com/sianachi/Nix/apps/go-workers/internal/docsbrowser"
)

func main() {
	if err := docsbrowser.Run(os.Args[1:], os.Stdin, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "nix-docs:", err)
		os.Exit(1)
	}
}
