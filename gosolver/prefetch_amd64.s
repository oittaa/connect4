//go:build amd64

#include "textflag.h"

// func prefetchAddr(addr unsafe.Pointer)
TEXT ·prefetchAddr(SB), NOSPLIT, $0-8
	MOVQ addr+0(FP), AX
	PREFETCHT0 (AX)
	RET
