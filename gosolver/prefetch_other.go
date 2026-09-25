//go:build !amd64 && !arm64

package main

import "unsafe"

const prefetchEnabled = false

func prefetchAddr(addr unsafe.Pointer) {}
