//go:build !amd64

package main

import "unsafe"

func prefetchAddr(addr unsafe.Pointer) {}
