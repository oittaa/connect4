//go:build arm64

#include "textflag.h"

// func prefetchAddr(addr unsafe.Pointer)
TEXT ·prefetchAddr(SB), NOSPLIT, $0-8
	MOVD addr+0(FP), R0
	PRFM (R0), PLDL1KEEP
	RET
