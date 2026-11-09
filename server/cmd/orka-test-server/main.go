//go:build orkatest

package main

import (
	"github.com/whysosaket/orka-api/internal/server"
	"log"
)

func main() {
	if err := server.RunTestBridge(); err != nil {
		log.Fatal(err)
	}
}
