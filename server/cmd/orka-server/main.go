package main

import (
	"context"
	"fmt"
	"github.com/whysosaket/orka-api/internal/server"
	"os"
)

func main() {
	if err := server.Command(context.Background(), os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
