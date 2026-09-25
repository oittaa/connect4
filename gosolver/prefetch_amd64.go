//go:build amd64

package main

import "unsafe"

const prefetchEnabled = true

func prefetchAddr(addr unsafe.Pointer)
