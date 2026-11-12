//go:build orkatest

package main

import (
	"github.com/whysosaket/orka-api/internal/server"
	"log"
	"os"
)

func main() {
	var err error
	if len(os.Args) == 2 {
		err = server.RunTestCommand(os.Args[1])
	} else {
		err = server.RunTestBridge()
	}
	if err != nil {
		log.Fatal(err)
	}
}
