# C4MV compact move-book format

`C4MV` version 1 stores one certified optimal move for each populated Connect 4 position. It is separate from the score-oriented `C4BK` format.

All integers are unsigned little-endian. Byte offsets are absolute from the beginning of the file.

## Fixed header

| Offset | Size | Value |
| ---: | ---: | --- |
| 0 | 4 | ASCII `C4MV` |
| 4 | 1 | format version `1` |
| 5 | 1 | board width `7` |
| 6 | 1 | board height `6` |
| 7 | 1 | indexing version `1` |
| 8 | 1 | maximum covered ply, currently at most `10` |
| 9 | 1 | bits per slot, `3` |
| 10 | 1 | checksum kind, `1` = CRC-32/ISO-HDLC |
| 11 | 1 | reserved, zero |
| 12 | 4 | directory entry count, exactly `max_ply + 1` |
| 16 | 4 | CRC-32/ISO-HDLC of all packed payload bytes |

CRC-32/ISO-HDLC uses reflected polynomial `0xedb88320`, initial value `0xffffffff`, and final XOR `0xffffffff`. The directory is not included in the checksum.

## Directory

The fixed header is followed by one 16-byte entry for each ply, in ascending order from zero through `max_ply`.

| Entry offset | Size | Value |
| ---: | ---: | --- |
| 0 | 1 | ply number |
| 1 | 3 | reserved, all zero |
| 4 | 4 | dense slot count |
| 8 | 4 | absolute byte offset of this ply's payload |
| 12 | 4 | payload byte length |

Sections are contiguous, ordered by ply, and begin immediately after the directory. A section length is `ceil(3 * slot_count / 8)`. Readers reject gaps, overlaps, trailing bytes, and inconsistent counts or lengths.

## Dense index

For a position with `d` discs:

1. Read the seven column heights from column 0 through column 6.
2. Compare that vector lexicographically with its reversal. If the reversal is smaller, reflect the board for indexing and remember the reflection. Equal vectors keep the original orientation.
3. Enumerate all height vectors whose entries are 0–6, whose sum is `d`, and which are lexicographically less than or equal to their reversals. Enumeration is lexicographic. The selected vector's zero-based position is `height_rank`.
4. In the indexing orientation, list occupied cells column by column from left to right and within each column from bottom to top.
5. Mark cells belonging to the side to move. There are `k = floor(d / 2)` such cells. If their zero-based list positions are `p1 < ... < pk`, then `color_rank = sum(C(pj, j), j=1..k)`. `C(n,k)` is zero when `k > n`.
6. `index = height_rank * C(d, floor(d / 2)) + color_rank`.

The stored column is in the indexing orientation. A reflected lookup maps it back with `6 - column`.

When the height vector equals its reversal, generation populates both colour-arrangement orientations. If a fully symmetric board maps both writes to the same slot, version 1 deterministically keeps the smaller indexing-orientation column. Every retained choice is optimal; the format does not require a self-reflecting tie.

## Packed moves

Entry `i` starts at bit `3*i`, counting from the least-significant bit of the first byte. Values may cross a byte boundary.

- `0`–`6`: certified optimal column in indexing orientation.
- `7`: unknown or unpopulated; callers must fall back to score-book/search selection.

Each ply begins on a byte boundary. Unused high bits in the final byte of a section are one. This is the same bit value as an all-unknown section and is validated by readers.

The required version-1 slot counts for plies 0–10 are:

```text
1, 4, 32, 132, 660, 2360, 9440, 30240, 104580, 304920, 941472
```

There are 1,393,841 slots total. The packed payload is 522,693 bytes; the 20-byte fixed header and eleven 16-byte directory entries make a complete depth-10 file 522,889 bytes.

A syntactically valid file may contain value-7 slots and is therefore a valid checkpoint or partial book. It must not be described or published as complete until exhaustive reachability and optimality validation succeeds.
