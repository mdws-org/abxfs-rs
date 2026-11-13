package main

import (
	"bytes"
	"cmp"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"unicode/utf8"
)

const (
	maxContentBytes = uint64(1) << 30
	maxDirDepth     = 64
	maxEntries      = 65536
)

var bamfsBackend = mustHex20("0x91520cdaaab44267e99d08fea7730d7a7c60e9c2")

type dirEntry struct {
	cleanName []byte
	cid       [32]byte
	isDir     bool
}

type validatedFile struct {
	size   uint64
	sha256 [32]byte
	parts  [][]byte
}

type outputItem struct {
	isDir   bool
	sortKey string
	depth   int
	line    string
	rawSegs []string
	file    *validatedFile
}

type contentListing struct {
	items      []outputItem
	fileCount  uint64
	totalBytes uint64
}

func verifyContent(idx *bundleIndex, hasOut bool) (contentListing, error) {
	c := &idx.content
	switch c.store {
	case "abxfs":
		return verifyABXFS(idx.root, c, hasOut)
	case "bamfs2":
		return verifyBAMFS2(idx.root, c, hasOut)
	case "bamfs1":
		return verifyBAMFS1(idx.root, c, hasOut)
	default:
		return contentListing{}, rejectf("index", "unknown content store")
	}
}

func verifyABXFS(rootCID [32]byte, c *contentInfo, hasOut bool) (contentListing, error) {
	dirByCID := make(map[[32]byte]int, len(c.abxDirs))
	for i, d := range c.abxDirs {
		if _, dup := dirByCID[d.cid]; dup {
			return contentListing{}, rejectf("content", "duplicate CID in dirs")
		}
		dirByCID[d.cid] = i
	}
	fileByCID := make(map[[32]byte]int, len(c.abxFiles))
	for i, f := range c.abxFiles {
		if _, dup := fileByCID[f.cid]; dup {
			return contentListing{}, rejectf("content", "duplicate CID in files")
		}
		if _, both := dirByCID[f.cid]; both {
			return contentListing{}, rejectf("content", "CID appears in both dirs and files")
		}
		fileByCID[f.cid] = i
	}

	usedNodes := make(map[[32]byte]bool, len(c.abxNodes))
	usedChunks := make(map[[32]byte]bool, len(c.abxChunks))
	verifiedChunks := make(map[[32]byte]bool, len(c.abxChunks))
	validatedDirs := make(map[[32]byte][]dirEntry, len(c.abxDirs))
	validatedFiles := make(map[[32]byte]*validatedFile, len(c.abxFiles))

	validateDir := func(cid [32]byte) ([]dirEntry, error) {
		if cached, ok := validatedDirs[cid]; ok {
			return cached, nil
		}
		dIdx, ok := dirByCID[cid]
		if !ok {
			return nil, rejectf("content", "missing directory entry")
		}
		d := c.abxDirs[dIdx]
		if keccak256([]byte{0x32}, d.root[:]) != d.cid {
			return nil, rejectf("content", "abxfs directory CID mismatch")
		}
		var entries []dirEntry
		if d.root != ([32]byte{}) {
			var err error
			entries, err = walkEntryTree(d.root, 0x42, false, c.abxNodes, usedNodes)
			if err != nil {
				return nil, err
			}
		}
		if err := checkDirEntries(entries, dirByCID, fileByCID); err != nil {
			return nil, err
		}
		validatedDirs[cid] = entries
		return entries, nil
	}

	validateFile := func(cid [32]byte) (*validatedFile, error) {
		if cached, ok := validatedFiles[cid]; ok {
			return cached, nil
		}
		fIdx, ok := fileByCID[cid]
		if !ok {
			return nil, rejectf("content", "missing file entry")
		}
		f := c.abxFiles[fIdx]
		mimeBytes, ok := f.mime.bytes()
		if !ok || len(mimeBytes) < 1 || len(mimeBytes) > 127 {
			return nil, rejectf("content", "abxfs mime must be 1 to 127 bytes")
		}
		mimeHash := keccak256(mimeBytes)
		if keccak256([]byte{0x31}, f.root[:], mimeHash[:], f.codec[:], f.outputHash[:]) != f.cid {
			return nil, rejectf("content", "abxfs file CID mismatch")
		}
		codecZero := f.codec == ([32]byte{})
		outZero := f.outputHash == ([32]byte{})
		if codecZero != outZero {
			return nil, rejectf("content", "abxfs codec and outputHash zero mismatch")
		}
		if f.hasContent != !codecZero {
			return nil, rejectf("content", "abxfs content field presence mismatch")
		}

		var vf *validatedFile
		if !codecZero {
			if f.content.totalLen > maxContentBytes {
				return nil, rejectf("content", "file exceeds 1 GiB limit")
			}
			if keccak256(f.content.segs...) != f.outputHash {
				return nil, rejectf("content", "abxfs compressed content hash mismatch")
			}
			vf = &validatedFile{
				size:   f.content.totalLen,
				sha256: sha256Segs(f.content.segs),
				parts:  f.content.segs,
			}
		} else if f.root == ([32]byte{}) {
			vf = &validatedFile{
				size:   0,
				sha256: sha256.Sum256(nil),
			}
		} else {
			var parts [][]byte
			var fileSize uint64
			h := sha256.New()

			var walkChunks func(id [32]byte, expectedLevel int, isFirst bool) error
			walkChunks = func(id [32]byte, expectedLevel int, isFirst bool) error {
				ns, ok := c.abxNodes[id]
				if !ok {
					return rejectf("content", "missing abxfs chunk node")
				}
				usedNodes[id] = true
				blob, ok := ns.bytes()
				if !ok || len(blob) < 1 {
					return rejectf("content", "invalid abxfs chunk node")
				}
				if keccak256([]byte{0x41}, blob) != id {
					return rejectf("content", "abxfs chunk node hash mismatch")
				}
				level := int(blob[0])
				if isFirst {
					if level > 3 {
						return rejectf("content", "abxfs chunk node level > 3")
					}
				} else if level != expectedLevel {
					return rejectf("content", "abxfs chunk node child level mismatch")
				}
				if level >= 1 {
					if len(blob) < 3 {
						return rejectf("content", "truncated abxfs chunk branch")
					}
					n := int(binary.BigEndian.Uint16(blob[1:3]))
					if n < 2 || n > 128 || len(blob) != 3+42*n {
						return rejectf("content", "invalid abxfs chunk branch layout")
					}
					for i := 0; i < n; i++ {
						off := 3 + 42*i
						childID := [32]byte(blob[off : off+32])
						if err := walkChunks(childID, level-1, false); err != nil {
							return err
						}
					}
					return nil
				}
				if len(blob) < 1+38 || (len(blob)-1)%38 != 0 {
					return rejectf("content", "invalid abxfs chunk leaf layout")
				}
				m := (len(blob) - 1) / 38
				for i := 0; i < m; i++ {
					off := 1 + 38*i
					chunkID := [32]byte(blob[off : off+32])
					leafSize := readU48(blob[off+32 : off+38])
					ch, exists := c.abxChunks[chunkID]
					if !exists {
						return rejectf("content", "missing abxfs chunk")
					}
					usedChunks[chunkID] = true
					if !verifiedChunks[chunkID] {
						if ch.data.totalLen < 1 || ch.data.totalLen > maxContentBytes {
							return rejectf("content", "invalid abxfs chunk data length")
						}
						dataHash := keccak256(ch.data.segs...)
						u48Buf := putU48(ch.data.totalLen)
						if keccak256([]byte{0x30}, ch.backend[:], ch.inputHash[:], dataHash[:], u48Buf[:]) != chunkID {
							return rejectf("content", "abxfs chunk id mismatch")
						}
						verifiedChunks[chunkID] = true
					}
					if ch.data.totalLen != leafSize {
						return rejectf("content", "abxfs chunk length does not match leaf size")
					}
					if leafSize > maxContentBytes-fileSize {
						return rejectf("content", "file exceeds 1 GiB limit")
					}
					fileSize += leafSize
					for _, seg := range ch.data.segs {
						h.Write(seg)
						parts = append(parts, seg)
					}
				}
				return nil
			}

			if err := walkChunks(f.root, 0, true); err != nil {
				return nil, err
			}
			var sum [32]byte
			copy(sum[:], h.Sum(nil))
			vf = &validatedFile{size: fileSize, sha256: sum, parts: parts}
		}

		validatedFiles[cid] = vf
		return vf, nil
	}

	listing, err := buildListing(rootCID, dirByCID, fileByCID, validateDir, validateFile, hasOut)
	if err != nil {
		return contentListing{}, err
	}
	if len(validatedDirs) != len(c.abxDirs) ||
		len(validatedFiles) != len(c.abxFiles) ||
		len(usedNodes) != len(c.abxNodes) ||
		len(usedChunks) != len(c.abxChunks) {
		return contentListing{}, rejectf("content", "unreached entries in abxfs content")
	}
	return listing, nil
}

func verifyBAMFS2(rootCID [32]byte, c *contentInfo, hasOut bool) (contentListing, error) {
	dirByCID := make(map[[32]byte]int, len(c.bam2Dirs))
	for i, d := range c.bam2Dirs {
		if _, dup := dirByCID[d.cid]; dup {
			return contentListing{}, rejectf("content", "duplicate CID in dirs")
		}
		dirByCID[d.cid] = i
	}
	fileByCID := make(map[[32]byte]int, len(c.bam2Files))
	for i, f := range c.bam2Files {
		if _, dup := fileByCID[f.cid]; dup {
			return contentListing{}, rejectf("content", "duplicate CID in files")
		}
		if _, both := dirByCID[f.cid]; both {
			return contentListing{}, rejectf("content", "CID appears in both dirs and files")
		}
		fileByCID[f.cid] = i
	}

	usedNodes := make(map[[32]byte]bool, len(c.bam2Nodes))
	usedChunks := make(map[[32]byte]bool, len(c.bam2Chunks))
	verifiedChunks := make(map[[32]byte]bool, len(c.bam2Chunks))
	validatedDirs := make(map[[32]byte][]dirEntry, len(c.bam2Dirs))
	validatedFiles := make(map[[32]byte]*validatedFile, len(c.bam2Files))

	validateDir := func(cid [32]byte) ([]dirEntry, error) {
		if cached, ok := validatedDirs[cid]; ok {
			return cached, nil
		}
		dIdx, ok := dirByCID[cid]
		if !ok {
			return nil, rejectf("content", "missing directory entry")
		}
		d := c.bam2Dirs[dIdx]
		if keccak256([]byte{0x12}, d.root[:]) != d.cid {
			return nil, rejectf("content", "bamfs2 directory CID mismatch")
		}
		entries, err := walkEntryTree(d.root, 0x22, true, c.bam2Nodes, usedNodes)
		if err != nil {
			return nil, err
		}
		if err := checkDirEntries(entries, dirByCID, fileByCID); err != nil {
			return nil, err
		}
		validatedDirs[cid] = entries
		return entries, nil
	}

	validateFile := func(cid [32]byte) (*validatedFile, error) {
		if cached, ok := validatedFiles[cid]; ok {
			return cached, nil
		}
		fIdx, ok := fileByCID[cid]
		if !ok {
			return nil, rejectf("content", "missing file entry")
		}
		f := c.bam2Files[fIdx]
		if f.compression > 255 {
			return nil, rejectf("content", "bamfs2 compression exceeds 255")
		}
		comp := byte(f.compression)
		if f.hasContent != (comp != 0) {
			return nil, rejectf("content", "bamfs2 content presence mismatch")
		}
		mimeBytes, ok := f.mime.bytes()
		if !ok || !utf8.Valid(mimeBytes) {
			return nil, rejectf("content", "bamfs2 mime is not valid UTF-8")
		}
		mimeHash := keccak256(mimeBytes)
		if keccak256([]byte{0x11}, f.root[:], mimeHash[:], []byte{comp}, f.outputHash[:]) != f.cid {
			return nil, rejectf("content", "bamfs2 file CID mismatch")
		}

		var vf *validatedFile
		if comp != 0 {
			if f.content.totalLen > maxContentBytes {
				return nil, rejectf("content", "file exceeds 1 GiB limit")
			}
			if keccak256(f.content.segs...) != f.outputHash {
				return nil, rejectf("content", "bamfs2 compressed content hash mismatch")
			}
			vf = &validatedFile{
				size:   f.content.totalLen,
				sha256: sha256Segs(f.content.segs),
				parts:  f.content.segs,
			}
		} else {
			if f.outputHash != ([32]byte{}) {
				return nil, rejectf("content", "bamfs2 uncompressed outputHash must be zero")
			}
			var parts [][]byte
			var fileSize uint64
			h := sha256.New()

			var walkChunks func(id [32]byte, expectedLevel int, isFirst bool) error
			walkChunks = func(id [32]byte, expectedLevel int, isFirst bool) error {
				ns, ok := c.bam2Nodes[id]
				if !ok {
					return rejectf("content", "missing bamfs2 chunk node")
				}
				usedNodes[id] = true
				blob, ok := ns.bytes()
				if !ok || len(blob) < 1 {
					return rejectf("content", "invalid bamfs2 chunk node")
				}
				if keccak256([]byte{0x21}, blob) != id {
					return rejectf("content", "bamfs2 chunk node hash mismatch")
				}
				level := int(blob[0])
				if isFirst {
					if level > 3 {
						return rejectf("content", "bamfs2 chunk node level > 3")
					}
				} else if level != expectedLevel {
					return rejectf("content", "bamfs2 chunk node child level mismatch")
				}
				if level >= 1 {
					if len(blob) < 3 {
						return rejectf("content", "truncated bamfs2 chunk branch")
					}
					n := int(binary.BigEndian.Uint16(blob[1:3]))
					if n < 2 || n > 128 || len(blob) != 3+42*n {
						return rejectf("content", "invalid bamfs2 chunk branch layout")
					}
					for i := 0; i < n; i++ {
						off := 3 + 42*i
						childID := [32]byte(blob[off : off+32])
						if err := walkChunks(childID, level-1, false); err != nil {
							return err
						}
					}
					return nil
				}
				if len(blob) < 1+34 || (len(blob)-1)%34 != 0 {
					return rejectf("content", "invalid bamfs2 chunk leaf layout")
				}
				m := (len(blob) - 1) / 34
				for i := 0; i < m; i++ {
					off := 1 + 34*i
					chunkID := [32]byte(blob[off : off+32])
					leafSize := uint64(binary.BigEndian.Uint16(blob[off+32 : off+34]))
					ch, exists := c.bam2Chunks[chunkID]
					if !exists {
						return rejectf("content", "missing bamfs2 chunk")
					}
					usedChunks[chunkID] = true
					if !verifiedChunks[chunkID] {
						if ch.totalLen > maxContentBytes {
							return rejectf("content", "bamfs2 chunk exceeds size limit")
						}
						if keccak256PrefixSegs(bamfsBackend[:], ch.segs) != chunkID {
							return rejectf("content", "bamfs2 chunk hash mismatch")
						}
						verifiedChunks[chunkID] = true
					}
					if ch.totalLen != leafSize {
						return rejectf("content", "bamfs2 chunk length mismatch")
					}
					if leafSize > maxContentBytes-fileSize {
						return rejectf("content", "file exceeds 1 GiB limit")
					}
					fileSize += leafSize
					for _, seg := range ch.segs {
						h.Write(seg)
						parts = append(parts, seg)
					}
				}
				return nil
			}

			if err := walkChunks(f.root, 0, true); err != nil {
				return nil, err
			}
			if fileSize != f.size {
				return nil, rejectf("content", "bamfs2 file size does not match chunks")
			}
			var sum [32]byte
			copy(sum[:], h.Sum(nil))
			vf = &validatedFile{size: fileSize, sha256: sum, parts: parts}
		}

		validatedFiles[cid] = vf
		return vf, nil
	}

	listing, err := buildListing(rootCID, dirByCID, fileByCID, validateDir, validateFile, hasOut)
	if err != nil {
		return contentListing{}, err
	}
	if len(validatedDirs) != len(c.bam2Dirs) ||
		len(validatedFiles) != len(c.bam2Files) ||
		len(usedNodes) != len(c.bam2Nodes) ||
		len(usedChunks) != len(c.bam2Chunks) {
		return contentListing{}, rejectf("content", "unreached entries in bamfs2 content")
	}
	return listing, nil
}

func verifyBAMFS1(rootCID [32]byte, c *contentInfo, hasOut bool) (contentListing, error) {
	dirByCID := make(map[[32]byte]int, len(c.bam1Dirs))
	for i, d := range c.bam1Dirs {
		if _, dup := dirByCID[d.cid]; dup {
			return contentListing{}, rejectf("content", "duplicate CID in dirs")
		}
		dirByCID[d.cid] = i
	}
	fileByCID := make(map[[32]byte]int, len(c.bam1Files))
	for i, f := range c.bam1Files {
		if _, dup := fileByCID[f.cid]; dup {
			return contentListing{}, rejectf("content", "duplicate CID in files")
		}
		if _, both := dirByCID[f.cid]; both {
			return contentListing{}, rejectf("content", "CID appears in both dirs and files")
		}
		fileByCID[f.cid] = i
	}

	usedChunks := make(map[[32]byte]bool, len(c.bam1Chunks))
	verifiedChunks := make(map[[32]byte]bool, len(c.bam1Chunks))
	validatedDirs := make(map[[32]byte][]dirEntry, len(c.bam1Dirs))
	validatedFiles := make(map[[32]byte]*validatedFile, len(c.bam1Files))

	validateDir := func(cid [32]byte) ([]dirEntry, error) {
		if cached, ok := validatedDirs[cid]; ok {
			return cached, nil
		}
		dIdx, ok := dirByCID[cid]
		if !ok {
			return nil, rejectf("content", "missing directory entry")
		}
		d := c.bam1Dirs[dIdx]
		entryHashes := make([]byte, 0, 32*len(d.entries))
		entries := make([]dirEntry, 0, len(d.entries))
		for _, ent := range d.entries {
			rawName, ok := ent.name.bytes()
			if !ok || !utf8.Valid(rawName) {
				return nil, rejectf("content", "bamfs1 entry name is not valid UTF-8")
			}
			nameHash := keccak256(rawName)
			var isDirByte byte
			if ent.isDir {
				isDirByte = 1
			}
			eh := keccak256(nameHash[:], ent.cid[:], []byte{isDirByte})
			entryHashes = append(entryHashes, eh[:]...)
			entries = append(entries, dirEntry{
				cleanName: dropUTF8BOM(rawName),
				cid:       ent.cid,
				isDir:     ent.isDir,
			})
		}
		entriesDigest := keccak256(entryHashes)
		if keccak256([]byte{0x02}, entriesDigest[:]) != d.cid {
			return nil, rejectf("content", "bamfs1 directory CID mismatch")
		}
		if err := checkDirEntries(entries, dirByCID, fileByCID); err != nil {
			return nil, err
		}
		validatedDirs[cid] = entries
		return entries, nil
	}

	validateFile := func(cid [32]byte) (*validatedFile, error) {
		if cached, ok := validatedFiles[cid]; ok {
			return cached, nil
		}
		fIdx, ok := fileByCID[cid]
		if !ok {
			return nil, rejectf("content", "missing file entry")
		}
		f := c.bam1Files[fIdx]
		if f.compression > 255 {
			return nil, rejectf("content", "bamfs1 compression exceeds 255")
		}
		comp := byte(f.compression)
		if f.hasContent != (comp != 0) {
			return nil, rejectf("content", "bamfs1 content presence mismatch")
		}
		mimeBytes, ok := f.mime.bytes()
		if !ok || !utf8.Valid(mimeBytes) {
			return nil, rejectf("content", "bamfs1 mime is not valid UTF-8")
		}
		mimeHash := keccak256(mimeBytes)
		chunkIDsConcat := make([]byte, 0, 32*len(f.chunks))
		for _, cID := range f.chunks {
			chunkIDsConcat = append(chunkIDsConcat, cID[:]...)
		}
		chunksDigest := keccak256(chunkIDsConcat)
		if keccak256([]byte{0x01}, chunksDigest[:], mimeHash[:], []byte{comp}, f.outputHash[:]) != f.cid {
			return nil, rejectf("content", "bamfs1 file CID mismatch")
		}

		var vf *validatedFile
		if comp != 0 {
			if f.content.totalLen > maxContentBytes {
				return nil, rejectf("content", "file exceeds 1 GiB limit")
			}
			if keccak256(f.content.segs...) != f.outputHash {
				return nil, rejectf("content", "bamfs1 compressed content hash mismatch")
			}
			vf = &validatedFile{
				size:   f.content.totalLen,
				sha256: sha256Segs(f.content.segs),
				parts:  f.content.segs,
			}
		} else {
			if f.outputHash != ([32]byte{}) {
				return nil, rejectf("content", "bamfs1 uncompressed outputHash must be zero")
			}
			var parts [][]byte
			var fileSize uint64
			h := sha256.New()
			for _, chunkID := range f.chunks {
				ch, exists := c.bam1Chunks[chunkID]
				if !exists {
					return nil, rejectf("content", "missing bamfs1 chunk")
				}
				usedChunks[chunkID] = true
				if !verifiedChunks[chunkID] {
					if ch.totalLen > maxContentBytes {
						return nil, rejectf("content", "bamfs1 chunk exceeds size limit")
					}
					if keccak256PrefixSegs(bamfsBackend[:], ch.segs) != chunkID {
						return nil, rejectf("content", "bamfs1 chunk hash mismatch")
					}
					verifiedChunks[chunkID] = true
				}
				if ch.totalLen > maxContentBytes-fileSize {
					return nil, rejectf("content", "file exceeds 1 GiB limit")
				}
				fileSize += ch.totalLen
				for _, seg := range ch.segs {
					h.Write(seg)
					parts = append(parts, seg)
				}
			}
			var sum [32]byte
			copy(sum[:], h.Sum(nil))
			vf = &validatedFile{size: fileSize, sha256: sum, parts: parts}
		}

		validatedFiles[cid] = vf
		return vf, nil
	}

	listing, err := buildListing(rootCID, dirByCID, fileByCID, validateDir, validateFile, hasOut)
	if err != nil {
		return contentListing{}, err
	}
	if len(validatedDirs) != len(c.bam1Dirs) ||
		len(validatedFiles) != len(c.bam1Files) ||
		len(usedChunks) != len(c.bam1Chunks) {
		return contentListing{}, rejectf("content", "unreached entries in bamfs1 content")
	}
	return listing, nil
}

func walkEntryTree(
	rootID [32]byte,
	prefix byte,
	isBAMFS bool,
	nodes map[[32]byte]byteStr,
	usedNodes map[[32]byte]bool,
) ([]dirEntry, error) {
	var entries []dirEntry
	var walk func(id [32]byte, expectedLevel int, isFirst bool) error
	walk = func(id [32]byte, expectedLevel int, isFirst bool) error {
		ns, ok := nodes[id]
		if !ok {
			return rejectf("content", "missing directory entry node")
		}
		usedNodes[id] = true
		blob, ok := ns.bytes()
		if !ok || len(blob) < 1 {
			return rejectf("content", "invalid directory entry node")
		}
		if keccak256([]byte{prefix}, blob) != id {
			return rejectf("content", "directory entry node hash mismatch")
		}
		level := int(blob[0])
		if isFirst {
			if level > 3 {
				return rejectf("content", "directory entry node level > 3")
			}
		} else if level != expectedLevel {
			return rejectf("content", "directory entry child level mismatch")
		}

		if level >= 1 {
			if len(blob) < 3 {
				return rejectf("content", "truncated directory entry branch")
			}
			n := int(binary.BigEndian.Uint16(blob[1:3]))
			if n < 2 || n > 128 || len(blob) != 3+36*n {
				return rejectf("content", "invalid directory entry branch layout")
			}
			for i := 0; i < n; i++ {
				off := 3 + 36*i
				childID := [32]byte(blob[off : off+32])
				if err := walk(childID, level-1, false); err != nil {
					return err
				}
			}
			return nil
		}

		if len(blob) < 3 {
			return rejectf("content", "truncated directory entry leaf")
		}
		n := int(binary.BigEndian.Uint16(blob[1:3]))
		if n < 1 {
			return rejectf("content", "directory entry leaf has zero entries")
		}
		recStart := 3 + 2*n
		if len(blob) < recStart {
			return rejectf("content", "truncated directory entry leaf offsets")
		}
		recArea := blob[recStart:]
		pos := 0
		for i := 0; i < n; i++ {
			off := int(binary.BigEndian.Uint16(blob[3+2*i : 3+2*i+2]))
			if off != pos || pos >= len(recArea) {
				return rejectf("content", "invalid record offset in directory entry leaf")
			}
			nameLen := int(recArea[pos])
			if nameLen < 1 || pos+34+nameLen > len(recArea) {
				return rejectf("content", "invalid record in directory entry leaf")
			}
			rawName := recArea[pos+1 : pos+1+nameLen]
			isDirByte := recArea[pos+1+nameLen]
			if isDirByte != 0 && isDirByte != 1 {
				return rejectf("content", "invalid isDir flag in directory entry record")
			}
			entryCID := [32]byte(recArea[pos+2+nameLen : pos+34+nameLen])
			pos += 34 + nameLen

			cleanName := rawName
			if isBAMFS {
				if !utf8.Valid(rawName) {
					return rejectf("content", "BAMFS entry name is not valid UTF-8")
				}
				cleanName = dropUTF8BOM(rawName)
			}
			entries = append(entries, dirEntry{
				cleanName: cleanName,
				cid:       entryCID,
				isDir:     isDirByte == 1,
			})
		}
		if pos != len(recArea) {
			return rejectf("content", "trailing bytes in directory entry leaf")
		}
		return nil
	}

	if err := walk(rootID, 0, true); err != nil {
		return nil, err
	}
	return entries, nil
}

func checkDirEntries(entries []dirEntry, dirByCID, fileByCID map[[32]byte]int) error {
	seenNames := make(map[string]struct{}, len(entries))
	for _, ent := range entries {
		key := string(ent.cleanName)
		if _, dup := seenNames[key]; dup {
			return rejectf("content", "duplicate entry name in directory")
		}
		seenNames[key] = struct{}{}
		if ent.isDir {
			if _, ok := dirByCID[ent.cid]; !ok {
				return rejectf("content", "directory entry CID not found in dirs")
			}
		} else {
			if _, ok := fileByCID[ent.cid]; !ok {
				return rejectf("content", "file entry CID not found in files")
			}
		}
	}
	return nil
}

func buildListing(
	rootCID [32]byte,
	dirByCID, fileByCID map[[32]byte]int,
	validateDir func([32]byte) ([]dirEntry, error),
	validateFile func([32]byte) (*validatedFile, error),
	hasOut bool,
) (contentListing, error) {
	if _, isDir := dirByCID[rootCID]; isDir {
		var items []outputItem
		var totalEntries uint64
		var fileCount uint64
		var totalBytes uint64
		activeDirs := make(map[[32]byte]bool)

		var walkDir func(cid [32]byte, encPrefix string, rawSegs []string, depth int) error
		walkDir = func(cid [32]byte, encPrefix string, rawSegs []string, depth int) error {
			if activeDirs[cid] {
				return rejectf("content", "directory contains itself")
			}
			activeDirs[cid] = true
			defer delete(activeDirs, cid)

			entries, err := validateDir(cid)
			if err != nil {
				return err
			}
			for _, ent := range entries {
				totalEntries++
				if totalEntries > maxEntries {
					return rejectf("content", "bundle exceeds 65,536 entries")
				}
				if hasOut && !isSafeOutName(ent.cleanName) {
					return rejectf("content", "unsafe entry name for output directory")
				}
				encName := percentEncodeName(ent.cleanName)
				childEnc := encName
				if encPrefix != "" || depth > 0 {
					childEnc = encPrefix + "/" + encName
				}
				var childRaw []string
				if hasOut {
					childRaw = append(rawSegs[:len(rawSegs):len(rawSegs)], string(ent.cleanName))
				}
				if ent.isDir {
					nextDepth := depth + 1
					if nextDepth > maxDirDepth {
						return rejectf("content", "directory nesting exceeds 64")
					}
					dirPath := childEnc + "/"
					items = append(items, outputItem{
						isDir:   true,
						sortKey: dirPath,
						depth:   nextDepth,
						line:    "d " + dirPath,
					})
					if err := walkDir(ent.cid, childEnc, childRaw, nextDepth); err != nil {
						return err
					}
				} else {
					vf, err := validateFile(ent.cid)
					if err != nil {
						return err
					}
					if vf.size > maxContentBytes-totalBytes {
						return rejectf("content", "total content exceeds 1 GiB")
					}
					totalBytes += vf.size
					fileCount++
					items = append(items, outputItem{
						isDir:   false,
						sortKey: childEnc,
						depth:   depth + 1,
						line:    fmt.Sprintf("f %s %d %x", childEnc, vf.size, vf.sha256),
						rawSegs: childRaw,
						file:    vf,
					})
				}
			}
			return nil
		}

		if err := walkDir(rootCID, "", nil, 0); err != nil {
			return contentListing{}, err
		}
		slices.SortFunc(items, func(a, b outputItem) int {
			if c := strings.Compare(a.sortKey, b.sortKey); c != 0 {
				return c
			}
			return cmp.Compare(a.depth, b.depth)
		})
		return contentListing{
			items:      items,
			fileCount:  fileCount,
			totalBytes: totalBytes,
		}, nil
	}

	if _, isFile := fileByCID[rootCID]; isFile {
		if hasOut {
			return contentListing{}, rejectf("content", "root file has empty name for output directory")
		}
		vf, err := validateFile(rootCID)
		if err != nil {
			return contentListing{}, err
		}
		return contentListing{
			items: []outputItem{{
				isDir:   false,
				sortKey: "",
				depth:   0,
				line:    fmt.Sprintf("f  %d %x", vf.size, vf.sha256),
				file:    vf,
			}},
			fileCount:  1,
			totalBytes: vf.size,
		}, nil
	}

	return contentListing{}, rejectf("content", "bundle root not found in dirs or files")
}

func dropUTF8BOM(b []byte) []byte {
	return bytes.TrimPrefix(b, []byte{0xef, 0xbb, 0xbf})
}

func isSafeOutName(name []byte) bool {
	if len(name) == 0 {
		return false
	}
	if string(name) == "." || string(name) == ".." {
		return false
	}
	if bytes.IndexByte(name, '/') >= 0 || bytes.IndexByte(name, 0) >= 0 {
		return false
	}
	return true
}

const upperHex = "0123456789ABCDEF"

func percentEncodeName(name []byte) string {
	var sb strings.Builder
	sb.Grow(len(name))
	for _, b := range name {
		if (b >= 'A' && b <= 'Z') ||
			(b >= 'a' && b <= 'z') ||
			(b >= '0' && b <= '9') ||
			b == '-' || b == '.' || b == '_' || b == '~' {
			sb.WriteByte(b)
		} else {
			sb.WriteByte('%')
			sb.WriteByte(upperHex[b>>4])
			sb.WriteByte(upperHex[b&0x0f])
		}
	}
	return sb.String()
}

func sha256Segs(segs [][]byte) [32]byte {
	h := sha256.New()
	for _, seg := range segs {
		h.Write(seg)
	}
	var out [32]byte
	copy(out[:], h.Sum(nil))
	return out
}

func readU48(b []byte) uint64 {
	return uint64(b[0])<<40 |
		uint64(b[1])<<32 |
		uint64(b[2])<<24 |
		uint64(b[3])<<16 |
		uint64(b[4])<<8 |
		uint64(b[5])
}

func putU48(v uint64) [6]byte {
	return [6]byte{
		byte(v >> 40),
		byte(v >> 32),
		byte(v >> 24),
		byte(v >> 16),
		byte(v >> 8),
		byte(v),
	}
}

func writeOutputFiles(outDir string, items []outputItem) error {
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return err
	}
	for _, it := range items {
		if it.isDir {
			continue
		}
		elems := make([]string, 1+len(it.rawSegs))
		elems[0] = outDir
		copy(elems[1:], it.rawSegs)
		dst := filepath.Join(elems...)
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return err
		}
		if err := writePartsToFile(dst, it.file.parts); err != nil {
			return err
		}
	}
	return nil
}

func writePartsToFile(dst string, parts [][]byte) error {
	f, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	for _, p := range parts {
		if _, err := f.Write(p); err != nil {
			f.Close()
			return err
		}
	}
	return f.Close()
}
