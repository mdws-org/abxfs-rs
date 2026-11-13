package main

import (
	"encoding/binary"
	"math/bits"
)

var keccakRC = [24]uint64{
	0x0000000000000001,
	0x0000000000008082,
	0x800000000000808a,
	0x8000000080008000,
	0x000000000000808b,
	0x0000000080000001,
	0x8000000080008081,
	0x8000000000008009,
	0x000000000000008a,
	0x0000000000000088,
	0x0000000080008009,
	0x000000008000000a,
	0x000000008000808b,
	0x800000000000008b,
	0x8000000000008089,
	0x8000000000008003,
	0x8000000000008002,
	0x8000000000000080,
	0x000000000000800a,
	0x800000008000000a,
	0x8000000080008081,
	0x8000000000008080,
	0x0000000080000001,
	0x8000000080008008,
}

var keccakRho = [24]int{
	1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14,
	27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44,
}

var keccakPi = [24]int{
	10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4,
	15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1,
}

func keccakF1600(a *[25]uint64) {
	var c [5]uint64
	var d [5]uint64
	for round := 0; round < 24; round++ {
		for x := 0; x < 5; x++ {
			c[x] = a[x] ^ a[x+5] ^ a[x+10] ^ a[x+15] ^ a[x+20]
		}
		for x := 0; x < 5; x++ {
			d[x] = c[(x+4)%5] ^ bits.RotateLeft64(c[(x+1)%5], 1)
		}
		for y := 0; y < 25; y += 5 {
			for x := 0; x < 5; x++ {
				a[y+x] ^= d[x]
			}
		}

		last := a[1]
		for t := 0; t < 24; t++ {
			dst := keccakPi[t]
			a[dst], last = bits.RotateLeft64(last, keccakRho[t]), a[dst]
		}

		for y := 0; y < 25; y += 5 {
			t0, t1, t2, t3, t4 := a[y], a[y+1], a[y+2], a[y+3], a[y+4]
			a[y] = t0 ^ ((^t1) & t2)
			a[y+1] = t1 ^ ((^t2) & t3)
			a[y+2] = t2 ^ ((^t3) & t4)
			a[y+3] = t3 ^ ((^t4) & t0)
			a[y+4] = t4 ^ ((^t0) & t1)
		}

		a[0] ^= keccakRC[round]
	}
}

func keccak256(chunks ...[]byte) [32]byte {
	var state [25]uint64
	var buf [136]byte
	used := 0
	for _, chunk := range chunks {
		for len(chunk) > 0 {
			if used == 0 && len(chunk) >= 136 {
				for i := 0; i < 17; i++ {
					state[i] ^= binary.LittleEndian.Uint64(chunk[8*i : 8*i+8])
				}
				keccakF1600(&state)
				chunk = chunk[136:]
				continue
			}
			n := copy(buf[used:], chunk)
			used += n
			chunk = chunk[n:]
			if used == 136 {
				for i := 0; i < 17; i++ {
					state[i] ^= binary.LittleEndian.Uint64(buf[8*i : 8*i+8])
				}
				keccakF1600(&state)
				used = 0
			}
		}
	}
	for i := used; i < 136; i++ {
		buf[i] = 0
	}
	buf[used] ^= 0x01
	buf[135] ^= 0x80
	for i := 0; i < 17; i++ {
		state[i] ^= binary.LittleEndian.Uint64(buf[8*i : 8*i+8])
	}
	keccakF1600(&state)

	var out [32]byte
	for i := 0; i < 4; i++ {
		binary.LittleEndian.PutUint64(out[8*i:8*i+8], state[i])
	}
	return out
}

func keccak256PrefixSegs(prefix []byte, segs [][]byte) [32]byte {
	if len(segs) == 0 {
		return keccak256(prefix)
	}
	if len(segs) == 1 {
		return keccak256(prefix, segs[0])
	}
	all := make([][]byte, 1+len(segs))
	all[0] = prefix
	copy(all[1:], segs)
	return keccak256(all...)
}
