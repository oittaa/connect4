package main

import (
	"fmt"
	"math/bits"
	"os"
	"runtime/pprof"
	"strings"
	"time"
	"unsafe"
)

const (
	Width    = 7
	Height   = 6
	Area     = Width * Height
	H1       = Height + 1              // 7
	MinScore = -(Area / 2) + 3         // -18
	MaxScore = (Area+1)/2 - 3          // 18
	Range    = MaxScore - MinScore + 1 // 37
	SymmPly  = 10
	TTSize   = 16777259 // 2^24 prime (same as native Rust)

	FlagUpper = 1
	FlagLower = 2
)

// Precomputed bitmasks matching the Rust engine.
const (
	Bottom = uint64(1) | (uint64(1) << 7) | (uint64(1) << 14) | (uint64(1) << 21) |
		(uint64(1) << 28) | (uint64(1) << 35) | (uint64(1) << 42) // 0x40810204081
	Board = Bottom * ((uint64(1) << Height) - 1)
	Top   = Bottom << Height
	Altx  = ((127 >> 1) / 3 * Bottom) << 1
)

var columnOrder = [Width]int{3, 4, 2, 5, 1, 6, 0}

func columnMask(col int) uint64 {
	return ((uint64(1) << Height) - 1) << (uint(col) * H1)
}

func topMask(col int) uint64 {
	return uint64(1) << (uint(Height-1) + uint(col)*H1)
}

func bottomMaskCol(col int) uint64 {
	return uint64(1) << (uint(col) * H1)
}

func haswond(x1 uint64, dir uint) uint64 {
	x2 := x1 & (x1 >> dir)
	return x2 & (x2 >> (2 * dir))
}

func hasWon(bb uint64) bool {
	return haswond(bb, Height) != 0 ||
		haswond(bb, H1) != 0 ||
		haswond(bb, Height+2) != 0 ||
		haswond(bb, 1) != 0
}

func computeWinningPosition(position, mask uint64) uint64 {
	// vertical
	r := (position << 1) & (position << 2) & (position << 3)

	// horizontal
	p := (position << H1) & (position << (2 * H1))
	r |= p & (position << (3 * H1))
	r |= p & (position >> H1)
	p = (position >> H1) & (position >> (2 * H1))
	r |= p & (position << H1)
	r |= p & (position >> (3 * H1))

	// diagonal /
	p = (position << Height) & (position << (2 * Height))
	r |= p & (position << (3 * Height))
	r |= p & (position >> Height)
	p = (position >> Height) & (position >> (2 * Height))
	r |= p & (position << Height)
	r |= p & (position >> (3 * Height))

	// diagonal \
	const d = Height + 2
	p = (position << d) & (position << (2 * d))
	r |= p & (position << (3 * d))
	r |= p & (position >> d)
	p = (position >> d) & (position >> (2 * d))
	r |= p & (position << d)
	r |= p & (position >> (3 * d))

	return r & (Board ^ mask)
}

func mirrorBitboard(bb uint64) uint64 {
	const c = 0x7F
	return ((bb & c) << 42) |
		(((bb >> 7) & c) << 35) |
		(((bb >> 14) & c) << 28) |
		(((bb >> 21) & c) << 21) |
		(((bb >> 28) & c) << 14) |
		(((bb >> 35) & c) << 7) |
		((bb >> 42) & c)
}

func canonicalKey(k uint64) uint64 {
	m := mirrorBitboard(k)
	if m < k {
		return m
	}
	return k
}

type Position struct {
	current uint64
	mask    uint64
	moves   uint8
}

func (p *Position) playBits(moveBit uint64) {
	p.current ^= p.mask
	p.mask |= moveBit
	p.moves++
}

func (p *Position) playCol(col int) {
	bit := (p.mask + bottomMaskCol(col)) & columnMask(col)
	p.playBits(bit)
}

func (p *Position) canPlay(col int) bool {
	return (p.mask & topMask(col)) == 0
}

func (p *Position) isDraw() bool {
	return int(p.moves) >= Area
}

func (p *Position) lastPlayerWon() bool {
	return p.moves > 0 && hasWon(p.current^p.mask)
}

func (p *Position) possible() uint64 {
	return (p.mask + Bottom) & Board
}

func (p *Position) canWinNext() bool {
	return computeWinningPosition(p.current, p.mask)&p.possible() != 0
}

func (p *Position) isWinningMove(col int) bool {
	return computeWinningPosition(p.current, p.mask)&p.possible()&columnMask(col) != 0
}

func (p *Position) possibleNonLosingMoves() uint64 {
	possible := p.possible()
	opponentWin := computeWinningPosition(p.current^p.mask, p.mask)
	forced := possible & opponentWin
	if forced != 0 {
		if forced&(forced-1) != 0 {
			return 0
		}
		possible = forced
	}
	return possible &^ (opponentWin >> 1)
}

// Count of 4-in-a-row lines passing through each cell.
// Indexed by bit index (col * 7 + row) in the 7×7 bitboard.
var cellWeight = [49]int{
	3, 4, 5, 5, 4, 3, 0,
	4, 6, 8, 8, 6, 4, 0,
	5, 8, 11, 11, 8, 5, 0,
	7, 10, 13, 13, 10, 7, 0,
	5, 8, 11, 11, 8, 5, 0,
	4, 6, 8, 8, 6, 4, 0,
	3, 4, 5, 5, 4, 3, 0,
}

func (p *Position) moveScore(moveBit uint64) int {
	threats := bits.OnesCount64(computeWinningPosition(p.current|moveBit, p.mask))
	return (threats << 4) | cellWeight[bits.TrailingZeros64(moveBit)]
}

func (p *Position) playSeq(seq string) int {
	for i, ch := range seq {
		if ch < '1' || ch > '7' {
			return i
		}
		col := int(ch - '1')
		if !p.canPlay(col) || p.isWinningMove(col) {
			p.playCol(col)
			return i + 1
		}
		p.playCol(col)
	}
	return len(seq)
}

func (p *Position) xevens() (int8, bool) {
	p1 := p.current
	p2 := p.current ^ p.mask
	encoded := 2*p1 + p2 + Bottom
	xe := p2 | (Altx &^ encoded)
	oe := Board - xe
	if haswond(oe, 1) != 0 {
		return 0, false
	}
	xeh := haswond(xe, H1)
	xed1 := haswond(xe, Height)
	xed2 := haswond(xe, Height+2)
	xeany := xeh | xed1 | xed2
	oeh := haswond(oe, H1)
	oed1 := haswond(oe, Height)
	oed2 := haswond(oe, Height+2)
	if oeh&(xeany-(Top+1)) != 0 {
		return 0, false
	}
	if oed1 != 0 && (oeh|oed1)&((xeh|xed1)-(Top+1)) != 0 {
		return 0, false
	}
	if oed2 != 0 && (oeh|oed2)&((xeh|xed2)-(Top+1)) != 0 {
		return 0, false
	}
	if xeany != 0 {
		return 1, true
	}
	return 0, true
}

func pack(score int, flag uint8) uint8 {
	s := score
	if s < MinScore {
		s = MinScore
	} else if s > MaxScore {
		s = MaxScore
	}
	switch flag {
	case FlagUpper:
		return uint8(s - MinScore + 1)
	case FlagLower:
		return uint8(s + MaxScore - 2*MinScore + 2)
	default:
		return 0
	}
}

func unpack(val uint8) (int, uint8) {
	v := int(val)
	if v > Range {
		return v + 2*MinScore - MaxScore - 2, FlagLower
	}
	return v + MinScore - 1, FlagUpper
}

type Table struct {
	keys    []uint32
	vals    []uint8
	keysPtr *uint32
	valsPtr *uint8
}

func NewTable() *Table {
	keys := make([]uint32, TTSize)
	vals := make([]uint8, TTSize)
	return &Table{
		keys:    keys,
		vals:    vals,
		keysPtr: unsafe.SliceData(keys),
		valsPtr: unsafe.SliceData(vals),
	}
}

func (t *Table) get(key uint64) (int, uint8, bool) {
	i := uintptr(key % TTSize)
	k := *(*uint32)(unsafe.Add(unsafe.Pointer(t.keysPtr), i*4))
	if k != uint32(key) {
		return 0, 0, false
	}
	packed := *(*uint8)(unsafe.Add(unsafe.Pointer(t.valsPtr), i))
	if packed == 0 {
		return 0, 0, false
	}
	score, flag := unpack(packed)
	return score, flag, true
}

func (t *Table) put(key uint64, score int, flag uint8) {
	packed := pack(score, flag)
	if packed == 0 {
		return
	}
	i := uintptr(key % TTSize)
	*(*uint32)(unsafe.Add(unsafe.Pointer(t.keysPtr), i*4)) = uint32(key)
	*(*uint8)(unsafe.Add(unsafe.Pointer(t.valsPtr), i)) = packed
}

type moveEntry struct {
	mv    uint64
	score int
}

type moveList struct {
	entries [Width]moveEntry
	size    int
}

func (ml *moveList) add(mv uint64, score int) {
	pos := ml.size
	ml.size++
	for pos > 0 && ml.entries[pos-1].score > score {
		ml.entries[pos] = ml.entries[pos-1]
		pos--
	}
	ml.entries[pos] = moveEntry{mv: mv, score: score}
}

func (ml *moveList) next() (uint64, bool) {
	if ml.size == 0 {
		return 0, false
	}
	ml.size--
	return ml.entries[ml.size].mv, true
}

type Solver struct {
	tt    *Table
	nodes uint64
}

func NewSolver() *Solver {
	return &Solver{
		tt: NewTable(),
	}
}

func (s *Solver) negamax(pos Position, alpha, beta int) int {
	s.nodes++

	possible := pos.possibleNonLosingMoves()
	if possible == 0 {
		return -((Area - int(pos.moves)) / 2)
	}

	if int(pos.moves) >= Area-2 {
		return 0
	}

	minS := -((Area - 2 - int(pos.moves)) / 2)
	if alpha < minS {
		alpha = minS
		if alpha >= beta {
			return alpha
		}
	}

	maxS := (Area - 1 - int(pos.moves)) / 2
	if beta > maxS {
		beta = maxS
		if alpha >= beta {
			return beta
		}
	}

	var key uint64
	if pos.moves <= SymmPly {
		key = canonicalKey(pos.current + pos.mask)
	} else {
		key = pos.current + pos.mask
	}

	if val, flag, ok := s.tt.get(key); ok {
		if flag == FlagLower {
			if alpha < val {
				alpha = val
				if alpha >= beta {
					return alpha
				}
			}
		} else if flag == FlagUpper && beta > val {
			beta = val
			if alpha >= beta {
				return beta
			}
		}
	}

	// Even-row parity upper bound
	if pos.moves%2 == 0 && beta >= 0 {
		if xe, ok := pos.xevens(); ok {
			ub := 0
			if xe > 0 {
				ub = -1
			}
			if beta > ub {
				beta = ub
				if alpha >= beta {
					return beta
				}
			}
		}
	}

	var moves moveList
	for i := Width - 1; i >= 0; i-- {
		col := columnOrder[i]
		mv := possible & columnMask(col)
		if mv != 0 {
			moves.add(mv, pos.moveScore(mv))
		}
	}

	for {
		mv, ok := moves.next()
		if !ok {
			break
		}
		child := pos
		child.playBits(mv)
		score := -s.negamax(child, -beta, -alpha)
		if score >= beta {
			s.tt.put(key, score, FlagLower)
			return score
		}
		if score > alpha {
			alpha = score
		}
	}

	s.tt.put(key, alpha, FlagUpper)
	return alpha
}

func (s *Solver) scorePosition(pos Position) int {
	if pos.canWinNext() {
		return (Area + 1 - int(pos.moves)) / 2
	}

	min := -((Area - int(pos.moves)) / 2)
	max := (Area + 1 - int(pos.moves)) / 2

	for min < max {
		med := min + (max-min)/2
		if med <= 0 && min/2 < med {
			med = min / 2
		} else if med >= 0 && max/2 > med {
			med = max / 2
		}
		r := s.negamax(pos, med, med+1)
		if r <= med {
			max = r
		} else {
			min = r
		}
	}
	return min
}

func (s *Solver) BestMove(pos Position) (int, int) {
	if pos.lastPlayerWon() || pos.isDraw() {
		return -1, 0
	}

	target := s.scorePosition(pos)

	bestCol := -1
	for _, col := range columnOrder {
		if !pos.canPlay(col) {
			continue
		}
		if pos.isWinningMove(col) {
			return col, target
		}
		child := pos
		child.playCol(col)
		var val int
		if child.canWinNext() {
			val = (Area + 1 - int(child.moves)) / 2
		} else {
			val = s.negamax(child, -target, -target+1)
		}
		if val <= -target {
			bestCol = col
			break
		}
	}
	return bestCol, target
}

func main() {
	var profFile, seq string

	for i := 1; i < len(os.Args); i++ {
		arg := os.Args[i]
		switch {
		case arg == "-cpuprofile" || arg == "--cpuprofile":
			if i+1 < len(os.Args) {
				i++
				profFile = os.Args[i]
			}
		case arg == "best-move" || strings.HasPrefix(arg, "-"):
			continue
		case seq == "":
			seq = arg
		}
	}

	if profFile == "" {
		profFile = os.Getenv("CPUPROFILE")
	}
	if profFile != "" {
		f, err := os.Create(profFile)
		if err != nil {
			fmt.Fprintf(os.Stderr, "cpuprofile: %v\n", err)
			os.Exit(1)
		}
		if err := pprof.StartCPUProfile(f); err != nil {
			fmt.Fprintf(os.Stderr, "cpuprofile: %v\n", err)
			os.Exit(1)
		}
		defer pprof.StopCPUProfile()
	}

	var pos Position
	if seq != "" {
		n := pos.playSeq(seq)
		if n != len(seq) {
			fmt.Fprintf(os.Stderr, "warning: stopped at move %d of %q\n", n, seq)
		}
	}

	solver := NewSolver()
	start := time.Now()
	bestCol, score := solver.BestMove(pos)
	elapsed := time.Since(start)

	var kns float64
	if elapsed.Seconds() > 0 {
		kns = float64(solver.nodes) / (elapsed.Seconds() * 1000.0)
	}

	// 1-based column for output
	colStr := "--"
	if bestCol >= 0 {
		colStr = fmt.Sprintf("%d", bestCol+1)
	}

	fmt.Printf("best_move: %s\n", colStr)
	fmt.Printf("score: %d\n", score)
	fmt.Printf("nodes: %d\n", solver.nodes)
	fmt.Printf("time: %.3fs (%.1f kn/s)\n", elapsed.Seconds(), kns)
}
