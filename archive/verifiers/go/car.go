package main

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/base32"
	"io"
	"os"
	"slices"
	"strings"
)

const (
	maxIndexBlockSize = 16_777_216
	maxRawBlockSize   = 1_048_576
)

var (
	carHeaderPrefix  = []byte{0xa2, 0x65, 0x72, 0x6f, 0x6f, 0x74, 0x73, 0x81, 0xd8, 0x2a, 0x58, 0x26, 0x00}
	carHeaderSuffix  = []byte{0x67, 0x76, 0x65, 0x72, 0x73, 0x69, 0x6f, 0x6e, 0x01}
	dagJSONCIDPrefix = []byte{0x01, 0xa9, 0x02, 0x12, 0x20}
	rawCIDPrefix     = []byte{0x01, 0x55, 0x12, 0x20}
	b32LowerNoPad    = base32.NewEncoding("abcdefghijklmnopqrstuvwxyz234567").WithPadding(base32.NoPadding)
)

func readContainer(f *os.File) ([]byte, [][36]byte, map[[36]byte][]byte, error) {
	r := bufio.NewReaderSize(f, 64*1024)

	hdrLen, eof, err := readVarint(r)
	if err != nil {
		return nil, nil, nil, err
	}
	if eof || hdrLen != 59 {
		return nil, nil, nil, rejectf("container", "invalid CAR header length")
	}

	var hdr [59]byte
	if err := readExact(r, hdr[:]); err != nil {
		return nil, nil, nil, err
	}
	if !bytes.Equal(hdr[0:13], carHeaderPrefix) || !bytes.Equal(hdr[50:59], carHeaderSuffix) {
		return nil, nil, nil, rejectf("container", "invalid CAR header bytes")
	}
	indexCID := [37]byte(hdr[13:50])
	if !bytes.Equal(indexCID[0:5], dagJSONCIDPrefix) {
		return nil, nil, nil, rejectf("container", "header root CID is not dag-json sha256")
	}

	firstBlkLen, eof, err := readVarint(r)
	if err != nil {
		return nil, nil, nil, err
	}
	if eof {
		return nil, nil, nil, rejectf("container", "missing index block")
	}
	if firstBlkLen < 37 {
		return nil, nil, nil, rejectf("container", "index block shorter than CID")
	}
	indexDataLen := firstBlkLen - 37
	if indexDataLen > maxIndexBlockSize {
		return nil, nil, nil, rejectf("container", "index block exceeds 16 MiB")
	}

	var gotIndexCID [37]byte
	if err := readExact(r, gotIndexCID[:]); err != nil {
		return nil, nil, nil, err
	}
	if gotIndexCID != indexCID {
		return nil, nil, nil, rejectf("container", "first block CID does not match header root")
	}

	indexData := make([]byte, indexDataLen)
	if err := readExact(r, indexData); err != nil {
		return nil, nil, nil, err
	}
	indexDigest := sha256.Sum256(indexData)
	if !bytes.Equal(indexDigest[:], indexCID[5:37]) {
		return nil, nil, nil, rejectf("container", "index block sha256 mismatch")
	}

	var rawOrder [][36]byte
	rawMap := make(map[[36]byte][]byte)

	for {
		blkLen, eof, err := readVarint(r)
		if err != nil {
			return nil, nil, nil, err
		}
		if eof {
			break
		}
		if blkLen < 36 {
			return nil, nil, nil, rejectf("container", "raw block shorter than CID")
		}
		dataLen := blkLen - 36
		if dataLen > maxRawBlockSize {
			return nil, nil, nil, rejectf("container", "raw block exceeds 1 MiB")
		}
		var cid [36]byte
		if err := readExact(r, cid[:]); err != nil {
			return nil, nil, nil, err
		}
		if !bytes.Equal(cid[0:4], rawCIDPrefix) {
			return nil, nil, nil, rejectf("container", "non-raw block after index")
		}
		if _, dup := rawMap[cid]; dup {
			return nil, nil, nil, rejectf("container", "duplicate raw block CID")
		}
		data := make([]byte, dataLen)
		if err := readExact(r, data); err != nil {
			return nil, nil, nil, err
		}
		digest := sha256.Sum256(data)
		if !bytes.Equal(digest[:], cid[4:36]) {
			return nil, nil, nil, rejectf("container", "raw block sha256 mismatch")
		}
		rawOrder = append(rawOrder, cid)
		rawMap[cid] = data
	}

	return indexData, rawOrder, rawMap, nil
}

func readVarint(r *bufio.Reader) (uint64, bool, error) {
	var val uint64
	for i := 0; i < 10; i++ {
		b, err := r.ReadByte()
		if err == io.EOF {
			if i == 0 {
				return 0, true, nil
			}
			return 0, false, rejectf("container", "truncated varint")
		}
		if err != nil {
			return 0, false, err
		}
		if i == 9 && b > 1 {
			return 0, false, rejectf("container", "varint overflow")
		}
		if i > 0 && b == 0 {
			return 0, false, rejectf("container", "non-minimal varint")
		}
		val |= uint64(b&0x7f) << (7 * i)
		if b < 0x80 {
			return val, false, nil
		}
	}
	return 0, false, rejectf("container", "varint too long")
}

func readExact(r *bufio.Reader, buf []byte) error {
	_, err := io.ReadFull(r, buf)
	if err == io.EOF || err == io.ErrUnexpectedEOF {
		return rejectf("container", "unexpected end of CAR stream")
	}
	return err
}

func parseRawCIDText(s string) ([36]byte, bool) {
	var zero [36]byte
	if len(s) < 2 || s[0] != 'b' {
		return zero, false
	}
	decoded, err := b32LowerNoPad.DecodeString(s[1:])
	if err != nil || len(decoded) != 36 {
		return zero, false
	}
	if b32LowerNoPad.EncodeToString(decoded) != s[1:] {
		return zero, false
	}
	if !bytes.Equal(decoded[0:4], rawCIDPrefix) {
		return zero, false
	}
	return [36]byte(decoded), true
}

func verifyLinkWalk(root jsonValue, rawOrder [][36]byte, rawMap map[[36]byte][]byte) error {
	var walkOrder [][36]byte
	seen := make(map[[36]byte]bool, len(rawOrder))

	var walk func(v jsonValue) error
	walk = func(v jsonValue) error {
		switch v.kind {
		case jsonObject:
			if len(v.members) == 1 && v.members[0].key == "/" && v.members[0].val.kind == jsonString {
				cid, ok := parseRawCIDText(v.members[0].val.str)
				if !ok {
					return rejectf("container", "invalid link CID in index")
				}
				if _, exists := rawMap[cid]; !exists {
					return rejectf("container", "link references missing raw block")
				}
				if !seen[cid] {
					seen[cid] = true
					walkOrder = append(walkOrder, cid)
				}
				return nil
			}
			sorted := slices.Clone(v.members)
			slices.SortFunc(sorted, func(a, b jsonMember) int {
				return strings.Compare(a.key, b.key)
			})
			for _, m := range sorted {
				if err := walk(m.val); err != nil {
					return err
				}
			}
		case jsonArray:
			for _, item := range v.items {
				if err := walk(item); err != nil {
					return err
				}
			}
		}
		return nil
	}

	if err := walk(root); err != nil {
		return err
	}
	if len(walkOrder) != len(rawOrder) {
		return rejectf("container", "unreferenced raw block in CAR")
	}
	for i := range rawOrder {
		if walkOrder[i] != rawOrder[i] {
			return rejectf("container", "raw blocks out of index walk order")
		}
	}
	return nil
}
