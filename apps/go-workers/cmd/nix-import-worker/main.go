package main

import (
	"github.com/sianachi/Nix/apps/go-workers/internal/role"
	"github.com/sianachi/Nix/apps/go-workers/internal/runtime"
)

func main() { runtime.Run(role.Import) }
