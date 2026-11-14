package main

import (
	"math"
	"math/big"
)

type byteStr struct {
	segs     [][]byte
	totalLen uint64
}

func (bs byteStr) bytes() ([]byte, bool) {
	if bs.totalLen > maxContentBytes {
		return nil, false
	}
	if len(bs.segs) == 0 {
		return []byte{}, true
	}
	if len(bs.segs) == 1 {
		return bs.segs[0], true
	}
	out := make([]byte, 0, int(bs.totalLen))
	for _, seg := range bs.segs {
		out = append(out, seg...)
	}
	return out, true
}

type projectInfo struct {
	chain    uint64
	org      [20]byte
	tokenStr string
	tokenInt *big.Int
	key      string
}

type storageEvidence struct {
	slot  [32]byte
	proof [][]byte
}

type accountEvidence struct {
	address [20]byte
	proof   [][]byte
	storage []storageEvidence
}

type chainStateEvidence struct {
	header   []byte
	accounts []accountEvidence
	codes    [][]byte
}

type arbitrumLog struct {
	parent [32]byte
	data   []byte
}

type proofInfo struct {
	kind      string
	header    []byte
	accounts  []accountEvidence
	final     bool
	l1        chainStateEvidence
	game      [20]byte
	l2        chainStateEvidence
	log       arbitrumLog
	block     uint64
	endpoints []string
	tx        [32]byte
}

type abxDirObj struct {
	cid  [32]byte
	root [32]byte
}

type abxFileObj struct {
	cid        [32]byte
	root       [32]byte
	mime       byteStr
	codec      [32]byte
	outputHash [32]byte
	hasContent bool
	content    byteStr
}

type abxChunkObj struct {
	backend   [20]byte
	inputHash [32]byte
	data      byteStr
}

type bam2FileObj struct {
	cid         [32]byte
	root        [32]byte
	mime        byteStr
	compression uint64
	outputHash  [32]byte
	size        uint64
	hasContent  bool
	content     byteStr
}

type bam1EntryObj struct {
	name  byteStr
	cid   [32]byte
	isDir bool
}

type bam1DirObj struct {
	cid     [32]byte
	entries []bam1EntryObj
}

type bam1FileObj struct {
	cid         [32]byte
	chunks      [][32]byte
	mime        byteStr
	compression uint64
	outputHash  [32]byte
	hasContent  bool
	content     byteStr
}

type contentInfo struct {
	store      string
	abxDirs    []abxDirObj
	abxFiles   []abxFileObj
	abxNodes   map[[32]byte]byteStr
	abxChunks  map[[32]byte]abxChunkObj
	bam2Dirs   []abxDirObj
	bam2Files  []bam2FileObj
	bam2Nodes  map[[32]byte]byteStr
	bam2Chunks map[[32]byte]byteStr
	bam1Dirs   []bam1DirObj
	bam1Files  []bam1FileObj
	bam1Chunks map[[32]byte]byteStr
}

type bundleIndex struct {
	project projectInfo
	root    [32]byte
	proof   proofInfo
	content contentInfo
}

var twoPow256 = new(big.Int).Lsh(big.NewInt(1), 256)

func decodeIndex(rootVal jsonValue, rawMap map[[36]byte][]byte) (*bundleIndex, error) {
	top, err := expectObject(rootVal, []string{"format", "project", "root", "proof", "content"}, nil)
	if err != nil {
		return nil, err
	}
	formatStr, err := expectString(top["format"])
	if err != nil || formatStr != "abx-archive/1" {
		return nil, rejectf("index", "unsupported or invalid format")
	}

	proj, err := decodeProject(top["project"])
	if err != nil {
		return nil, err
	}

	bundleRoot, err := expectHex32(top["root"])
	if err != nil {
		return nil, err
	}
	if bundleRoot == ([32]byte{}) {
		return nil, rejectf("index", "bundle root must not be zero")
	}

	prf, err := decodeProof(top["proof"], proj.chain)
	if err != nil {
		return nil, err
	}

	cnt, err := decodeContent(top["content"], proj.key, rawMap)
	if err != nil {
		return nil, err
	}

	return &bundleIndex{
		project: proj,
		root:    bundleRoot,
		proof:   prf,
		content: cnt,
	}, nil
}

func decodeProject(v jsonValue) (projectInfo, error) {
	m, err := expectObject(v, []string{"chain", "org", "token", "key"}, nil)
	if err != nil {
		return projectInfo{}, err
	}
	chain, err := parseIndexUint53(m["chain"])
	if err != nil {
		return projectInfo{}, err
	}
	if chain != 1 && chain != 8453 && chain != 42161 {
		return projectInfo{}, rejectf("index", "unsupported project chain")
	}
	org, err := expectHex20(m["org"])
	if err != nil {
		return projectInfo{}, err
	}
	tokenStr, err := expectString(m["token"])
	if err != nil {
		return projectInfo{}, err
	}
	tokenInt, ok := parseDecimalUint256(tokenStr)
	if !ok {
		return projectInfo{}, rejectf("index", "invalid token decimal")
	}
	key, err := expectString(m["key"])
	if err != nil || (key != "abxfs.cid" && key != "bamfs.cid") {
		return projectInfo{}, rejectf("index", "invalid project key")
	}
	return projectInfo{
		chain:    chain,
		org:      org,
		tokenStr: tokenStr,
		tokenInt: tokenInt,
		key:      key,
	}, nil
}

func decodeProof(v jsonValue, chain uint64) (proofInfo, error) {
	if v.kind != jsonObject {
		return proofInfo{}, rejectf("index", "proof must be an object")
	}
	var kindVal jsonValue
	hasKind := false
	for _, mem := range v.members {
		if mem.key == "kind" {
			kindVal = mem.val
			hasKind = true
			break
		}
	}
	if !hasKind {
		return proofInfo{}, rejectf("index", "missing proof.kind")
	}
	kind, err := expectString(kindVal)
	if err != nil {
		return proofInfo{}, err
	}

	switch kind {
	case "ethereum":
		if chain != 1 {
			return proofInfo{}, rejectf("index", "ethereum proof requires chain 1")
		}
		m, err := expectObject(v, []string{"kind", "header", "accounts"}, nil)
		if err != nil {
			return proofInfo{}, err
		}
		hdr, err := expectHexBytes(m["header"])
		if err != nil {
			return proofInfo{}, err
		}
		accs, err := decodeAccounts(m["accounts"])
		if err != nil {
			return proofInfo{}, err
		}
		return proofInfo{kind: kind, header: hdr, accounts: accs}, nil

	case "base":
		if chain != 8453 {
			return proofInfo{}, rejectf("index", "base proof requires chain 8453")
		}
		m, err := expectObject(v, []string{"kind", "final", "l1", "game", "l2"}, nil)
		if err != nil {
			return proofInfo{}, err
		}
		fin, err := expectBool(m["final"])
		if err != nil {
			return proofInfo{}, err
		}
		l1, err := decodeChainState(m["l1"], true)
		if err != nil {
			return proofInfo{}, err
		}
		game, err := expectHex20(m["game"])
		if err != nil {
			return proofInfo{}, err
		}
		l2, err := decodeChainState(m["l2"], false)
		if err != nil {
			return proofInfo{}, err
		}
		return proofInfo{kind: kind, final: fin, l1: l1, game: game, l2: l2}, nil

	case "arbitrum":
		if chain != 42161 {
			return proofInfo{}, rejectf("index", "arbitrum proof requires chain 42161")
		}
		m, err := expectObject(v, []string{"kind", "l1", "log", "l2"}, nil)
		if err != nil {
			return proofInfo{}, err
		}
		l1, err := decodeChainState(m["l1"], false)
		if err != nil {
			return proofInfo{}, err
		}
		logMap, err := expectObject(m["log"], []string{"parent", "data"}, nil)
		if err != nil {
			return proofInfo{}, err
		}
		parent, err := expectHex32(logMap["parent"])
		if err != nil {
			return proofInfo{}, err
		}
		data, err := expectHexBytes(logMap["data"])
		if err != nil {
			return proofInfo{}, err
		}
		l2, err := decodeChainState(m["l2"], false)
		if err != nil {
			return proofInfo{}, err
		}
		return proofInfo{
			kind: kind,
			l1:   l1,
			log:  arbitrumLog{parent: parent, data: data},
			l2:   l2,
		}, nil

	case "agreed":
		m, err := expectObject(v, []string{"kind", "block", "endpoints"}, nil)
		if err != nil {
			return proofInfo{}, err
		}
		blk, err := parseIndexUint53(m["block"])
		if err != nil {
			return proofInfo{}, err
		}
		if m["endpoints"].kind != jsonArray {
			return proofInfo{}, rejectf("index", "endpoints must be an array")
		}
		if len(m["endpoints"].items) < 2 {
			return proofInfo{}, rejectf("index", "agreed requires at least two endpoints")
		}
		endpoints := make([]string, 0, len(m["endpoints"].items))
		seenEP := make(map[string]bool, len(m["endpoints"].items))
		for _, item := range m["endpoints"].items {
			ep, err := expectString(item)
			if err != nil {
				return proofInfo{}, err
			}
			if !isValidEndpointHost(ep) || seenEP[ep] {
				return proofInfo{}, rejectf("index", "invalid or duplicate endpoint in agreed proof")
			}
			seenEP[ep] = true
			endpoints = append(endpoints, ep)
		}
		return proofInfo{kind: kind, block: blk, endpoints: endpoints}, nil

	case "logged":
		m, err := expectObject(v, []string{"kind", "block", "tx"}, nil)
		if err != nil {
			return proofInfo{}, err
		}
		blk, err := parseIndexUint53(m["block"])
		if err != nil {
			return proofInfo{}, err
		}
		tx, err := expectHex32(m["tx"])
		if err != nil {
			return proofInfo{}, err
		}
		return proofInfo{kind: kind, block: blk, tx: tx}, nil

	default:
		return proofInfo{}, rejectf("index", "unknown proof kind")
	}
}

func isValidEndpointHost(s string) bool {
	if len(s) == 0 {
		return false
	}
	for i := 0; i < len(s); i++ {
		b := s[i]
		if b <= 0x20 || b == 0x7f || b == ',' {
			return false
		}
	}
	return true
}

func decodeChainState(v jsonValue, withCodes bool) (chainStateEvidence, error) {
	req := []string{"header", "accounts"}
	if withCodes {
		req = []string{"header", "accounts", "codes"}
	}
	m, err := expectObject(v, req, nil)
	if err != nil {
		return chainStateEvidence{}, err
	}
	hdr, err := expectHexBytes(m["header"])
	if err != nil {
		return chainStateEvidence{}, err
	}
	accs, err := decodeAccounts(m["accounts"])
	if err != nil {
		return chainStateEvidence{}, err
	}
	var codes [][]byte
	if withCodes {
		if m["codes"].kind != jsonArray {
			return chainStateEvidence{}, rejectf("index", "codes must be an array")
		}
		codes = make([][]byte, 0, len(m["codes"].items))
		for _, item := range m["codes"].items {
			c, err := expectHexBytes(item)
			if err != nil {
				return chainStateEvidence{}, err
			}
			codes = append(codes, c)
		}
	}
	return chainStateEvidence{header: hdr, accounts: accs, codes: codes}, nil
}

func decodeAccounts(v jsonValue) ([]accountEvidence, error) {
	if v.kind != jsonArray {
		return nil, rejectf("index", "accounts must be an array")
	}
	out := make([]accountEvidence, 0, len(v.items))
	for _, item := range v.items {
		m, err := expectObject(item, []string{"address", "proof", "storage"}, nil)
		if err != nil {
			return nil, err
		}
		addr, err := expectHex20(m["address"])
		if err != nil {
			return nil, err
		}
		prf, err := decodeHexArray(m["proof"])
		if err != nil {
			return nil, err
		}
		if m["storage"].kind != jsonArray {
			return nil, rejectf("index", "storage must be an array")
		}
		st := make([]storageEvidence, 0, len(m["storage"].items))
		for _, sItem := range m["storage"].items {
			sm, err := expectObject(sItem, []string{"slot", "proof"}, nil)
			if err != nil {
				return nil, err
			}
			slot, err := expectHex32(sm["slot"])
			if err != nil {
				return nil, err
			}
			sPrf, err := decodeHexArray(sm["proof"])
			if err != nil {
				return nil, err
			}
			st = append(st, storageEvidence{slot: slot, proof: sPrf})
		}
		out = append(out, accountEvidence{address: addr, proof: prf, storage: st})
	}
	return out, nil
}

func decodeHexArray(v jsonValue) ([][]byte, error) {
	if v.kind != jsonArray {
		return nil, rejectf("index", "proof nodes must be an array")
	}
	out := make([][]byte, 0, len(v.items))
	for _, item := range v.items {
		b, err := expectHexBytes(item)
		if err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, nil
}

func decodeContent(v jsonValue, projKey string, rawMap map[[36]byte][]byte) (contentInfo, error) {
	if v.kind != jsonObject {
		return contentInfo{}, rejectf("index", "content must be an object")
	}
	var storeVal jsonValue
	hasStore := false
	for _, mem := range v.members {
		if mem.key == "store" {
			storeVal = mem.val
			hasStore = true
			break
		}
	}
	if !hasStore {
		return contentInfo{}, rejectf("index", "missing content.store")
	}
	store, err := expectString(storeVal)
	if err != nil {
		return contentInfo{}, err
	}

	switch store {
	case "abxfs":
		if projKey != "abxfs.cid" {
			return contentInfo{}, rejectf("index", "abxfs store requires key abxfs.cid")
		}
		m, err := expectObject(v, []string{"store", "dirs", "files", "nodes", "chunks"}, nil)
		if err != nil {
			return contentInfo{}, err
		}
		dirs, err := decodeSimpleDirs(m["dirs"])
		if err != nil {
			return contentInfo{}, err
		}
		if m["files"].kind != jsonArray {
			return contentInfo{}, rejectf("index", "files must be an array")
		}
		files := make([]abxFileObj, 0, len(m["files"].items))
		for _, item := range m["files"].items {
			fm, err := expectObject(item, []string{"cid", "root", "mime", "codec", "outputHash"}, []string{"content"})
			if err != nil {
				return contentInfo{}, err
			}
			cid, err := expectHex32(fm["cid"])
			if err != nil {
				return contentInfo{}, err
			}
			root, err := expectHex32(fm["root"])
			if err != nil {
				return contentInfo{}, err
			}
			mime, err := decodeByteStr(fm["mime"], rawMap)
			if err != nil {
				return contentInfo{}, err
			}
			codec, err := expectHex32(fm["codec"])
			if err != nil {
				return contentInfo{}, err
			}
			outHash, err := expectHex32(fm["outputHash"])
			if err != nil {
				return contentInfo{}, err
			}
			var contentBS byteStr
			cVal, hasContent := fm["content"]
			if hasContent {
				contentBS, err = decodeByteStr(cVal, rawMap)
				if err != nil {
					return contentInfo{}, err
				}
			}
			files = append(files, abxFileObj{
				cid:        cid,
				root:       root,
				mime:       mime,
				codec:      codec,
				outputHash: outHash,
				hasContent: hasContent,
				content:    contentBS,
			})
		}
		nodes, err := decodeByteStrMap(m["nodes"], rawMap)
		if err != nil {
			return contentInfo{}, err
		}
		if m["chunks"].kind != jsonObject {
			return contentInfo{}, rejectf("index", "chunks must be an object")
		}
		chunks := make(map[[32]byte]abxChunkObj, len(m["chunks"].members))
		for _, mem := range m["chunks"].members {
			id, ok := parseHex32(mem.key)
			if !ok {
				return contentInfo{}, rejectf("index", "invalid chunk id hex")
			}
			cm, err := expectObject(mem.val, []string{"backend", "inputHash", "data"}, nil)
			if err != nil {
				return contentInfo{}, err
			}
			backend, err := expectHex20(cm["backend"])
			if err != nil {
				return contentInfo{}, err
			}
			inHash, err := expectHex32(cm["inputHash"])
			if err != nil {
				return contentInfo{}, err
			}
			dataBS, err := decodeByteStr(cm["data"], rawMap)
			if err != nil {
				return contentInfo{}, err
			}
			chunks[id] = abxChunkObj{backend: backend, inputHash: inHash, data: dataBS}
		}
		return contentInfo{
			store:     store,
			abxDirs:   dirs,
			abxFiles:  files,
			abxNodes:  nodes,
			abxChunks: chunks,
		}, nil

	case "bamfs2":
		if projKey != "bamfs.cid" {
			return contentInfo{}, rejectf("index", "bamfs2 store requires key bamfs.cid")
		}
		m, err := expectObject(v, []string{"store", "dirs", "files", "nodes", "chunks"}, nil)
		if err != nil {
			return contentInfo{}, err
		}
		dirs, err := decodeSimpleDirs(m["dirs"])
		if err != nil {
			return contentInfo{}, err
		}
		if m["files"].kind != jsonArray {
			return contentInfo{}, rejectf("index", "files must be an array")
		}
		files := make([]bam2FileObj, 0, len(m["files"].items))
		for _, item := range m["files"].items {
			fm, err := expectObject(item, []string{"cid", "root", "mime", "compression", "outputHash", "size"}, []string{"content"})
			if err != nil {
				return contentInfo{}, err
			}
			cid, err := expectHex32(fm["cid"])
			if err != nil {
				return contentInfo{}, err
			}
			root, err := expectHex32(fm["root"])
			if err != nil {
				return contentInfo{}, err
			}
			mime, err := decodeByteStr(fm["mime"], rawMap)
			if err != nil {
				return contentInfo{}, err
			}
			comp, err := parseIndexUint53(fm["compression"])
			if err != nil {
				return contentInfo{}, err
			}
			outHash, err := expectHex32(fm["outputHash"])
			if err != nil {
				return contentInfo{}, err
			}
			sz, err := parseIndexUint53(fm["size"])
			if err != nil {
				return contentInfo{}, err
			}
			var contentBS byteStr
			cVal, hasContent := fm["content"]
			if hasContent {
				contentBS, err = decodeByteStr(cVal, rawMap)
				if err != nil {
					return contentInfo{}, err
				}
			}
			files = append(files, bam2FileObj{
				cid:         cid,
				root:        root,
				mime:        mime,
				compression: comp,
				outputHash:  outHash,
				size:        sz,
				hasContent:  hasContent,
				content:     contentBS,
			})
		}
		nodes, err := decodeByteStrMap(m["nodes"], rawMap)
		if err != nil {
			return contentInfo{}, err
		}
		chunks, err := decodeByteStrMap(m["chunks"], rawMap)
		if err != nil {
			return contentInfo{}, err
		}
		return contentInfo{
			store:      store,
			bam2Dirs:   dirs,
			bam2Files:  files,
			bam2Nodes:  nodes,
			bam2Chunks: chunks,
		}, nil

	case "bamfs1":
		if projKey != "bamfs.cid" {
			return contentInfo{}, rejectf("index", "bamfs1 store requires key bamfs.cid")
		}
		m, err := expectObject(v, []string{"store", "dirs", "files", "chunks"}, nil)
		if err != nil {
			return contentInfo{}, err
		}
		if m["dirs"].kind != jsonArray {
			return contentInfo{}, rejectf("index", "dirs must be an array")
		}
		dirs := make([]bam1DirObj, 0, len(m["dirs"].items))
		for _, item := range m["dirs"].items {
			dm, err := expectObject(item, []string{"cid", "entries"}, nil)
			if err != nil {
				return contentInfo{}, err
			}
			cid, err := expectHex32(dm["cid"])
			if err != nil {
				return contentInfo{}, err
			}
			if dm["entries"].kind != jsonArray {
				return contentInfo{}, rejectf("index", "entries must be an array")
			}
			entries := make([]bam1EntryObj, 0, len(dm["entries"].items))
			for _, eItem := range dm["entries"].items {
				em, err := expectObject(eItem, []string{"name", "cid", "isDir"}, nil)
				if err != nil {
					return contentInfo{}, err
				}
				nameBS, err := decodeByteStr(em["name"], rawMap)
				if err != nil {
					return contentInfo{}, err
				}
				eCID, err := expectHex32(em["cid"])
				if err != nil {
					return contentInfo{}, err
				}
				isDir, err := expectBool(em["isDir"])
				if err != nil {
					return contentInfo{}, err
				}
				entries = append(entries, bam1EntryObj{name: nameBS, cid: eCID, isDir: isDir})
			}
			dirs = append(dirs, bam1DirObj{cid: cid, entries: entries})
		}

		if m["files"].kind != jsonArray {
			return contentInfo{}, rejectf("index", "files must be an array")
		}
		files := make([]bam1FileObj, 0, len(m["files"].items))
		for _, item := range m["files"].items {
			fm, err := expectObject(item, []string{"cid", "chunks", "mime", "compression", "outputHash"}, []string{"content"})
			if err != nil {
				return contentInfo{}, err
			}
			cid, err := expectHex32(fm["cid"])
			if err != nil {
				return contentInfo{}, err
			}
			if fm["chunks"].kind != jsonArray {
				return contentInfo{}, rejectf("index", "file chunks must be an array")
			}
			chunkIDs := make([][32]byte, 0, len(fm["chunks"].items))
			for _, cItem := range fm["chunks"].items {
				cID, err := expectHex32(cItem)
				if err != nil {
					return contentInfo{}, err
				}
				chunkIDs = append(chunkIDs, cID)
			}
			mime, err := decodeByteStr(fm["mime"], rawMap)
			if err != nil {
				return contentInfo{}, err
			}
			comp, err := parseIndexUint53(fm["compression"])
			if err != nil {
				return contentInfo{}, err
			}
			outHash, err := expectHex32(fm["outputHash"])
			if err != nil {
				return contentInfo{}, err
			}
			var contentBS byteStr
			cVal, hasContent := fm["content"]
			if hasContent {
				contentBS, err = decodeByteStr(cVal, rawMap)
				if err != nil {
					return contentInfo{}, err
				}
			}
			files = append(files, bam1FileObj{
				cid:         cid,
				chunks:      chunkIDs,
				mime:        mime,
				compression: comp,
				outputHash:  outHash,
				hasContent:  hasContent,
				content:     contentBS,
			})
		}

		chunks, err := decodeByteStrMap(m["chunks"], rawMap)
		if err != nil {
			return contentInfo{}, err
		}
		return contentInfo{
			store:      store,
			bam1Dirs:   dirs,
			bam1Files:  files,
			bam1Chunks: chunks,
		}, nil

	default:
		return contentInfo{}, rejectf("index", "unknown content store")
	}
}

func decodeSimpleDirs(v jsonValue) ([]abxDirObj, error) {
	if v.kind != jsonArray {
		return nil, rejectf("index", "dirs must be an array")
	}
	dirs := make([]abxDirObj, 0, len(v.items))
	for _, item := range v.items {
		dm, err := expectObject(item, []string{"cid", "root"}, nil)
		if err != nil {
			return nil, err
		}
		cid, err := expectHex32(dm["cid"])
		if err != nil {
			return nil, err
		}
		root, err := expectHex32(dm["root"])
		if err != nil {
			return nil, err
		}
		dirs = append(dirs, abxDirObj{cid: cid, root: root})
	}
	return dirs, nil
}

func decodeByteStrMap(v jsonValue, rawMap map[[36]byte][]byte) (map[[32]byte]byteStr, error) {
	if v.kind != jsonObject {
		return nil, rejectf("index", "expected map object")
	}
	out := make(map[[32]byte]byteStr, len(v.members))
	for _, mem := range v.members {
		id, ok := parseHex32(mem.key)
		if !ok {
			return nil, rejectf("index", "invalid 32-byte hex key")
		}
		bs, err := decodeByteStr(mem.val, rawMap)
		if err != nil {
			return nil, err
		}
		out[id] = bs
	}
	return out, nil
}

func decodeByteStr(v jsonValue, rawMap map[[36]byte][]byte) (byteStr, error) {
	switch v.kind {
	case jsonString:
		b, ok := parseHexBytes(v.str)
		if !ok {
			return byteStr{}, rejectf("index", "invalid hex byte string")
		}
		if len(b) == 0 {
			return byteStr{}, nil
		}
		return byteStr{segs: [][]byte{b}, totalLen: uint64(len(b))}, nil
	case jsonArray:
		segs := make([][]byte, 0, len(v.items))
		var total uint64
		for _, item := range v.items {
			if item.kind != jsonObject || len(item.members) != 1 || item.members[0].key != "/" || item.members[0].val.kind != jsonString {
				return byteStr{}, rejectf("index", "invalid link in byte string array")
			}
			cid, ok := parseRawCIDText(item.members[0].val.str)
			if !ok {
				return byteStr{}, rejectf("index", "invalid CID in link")
			}
			blk, exists := rawMap[cid]
			if !exists {
				return byteStr{}, rejectf("container", "link names missing block")
			}
			if uint64(len(blk)) > math.MaxUint64-total {
				return byteStr{}, rejectf("index", "byte string length overflow")
			}
			total += uint64(len(blk))
			if len(blk) > 0 {
				segs = append(segs, blk)
			}
		}
		return byteStr{segs: segs, totalLen: total}, nil
	default:
		return byteStr{}, rejectf("index", "byte string must be hex string or link array")
	}
}

func expectObject(v jsonValue, required []string, optional []string) (map[string]jsonValue, error) {
	if v.kind != jsonObject {
		return nil, rejectf("index", "expected JSON object")
	}
	allowed := make(map[string]bool, len(required)+len(optional))
	for _, k := range required {
		allowed[k] = true
	}
	for _, k := range optional {
		allowed[k] = true
	}
	out := make(map[string]jsonValue, len(v.members))
	for _, mem := range v.members {
		if !allowed[mem.key] {
			return nil, rejectf("index", "unknown key %q", mem.key)
		}
		out[mem.key] = mem.val
	}
	for _, k := range required {
		if _, ok := out[k]; !ok {
			return nil, rejectf("index", "missing required key %q", k)
		}
	}
	return out, nil
}

func expectString(v jsonValue) (string, error) {
	if v.kind != jsonString {
		return "", rejectf("index", "expected JSON string")
	}
	return v.str, nil
}

func expectBool(v jsonValue) (bool, error) {
	if v.kind != jsonBool {
		return false, rejectf("index", "expected JSON boolean")
	}
	return v.boolean, nil
}

func expectHexBytes(v jsonValue) ([]byte, error) {
	if v.kind != jsonString {
		return nil, rejectf("index", "expected hex string")
	}
	b, ok := parseHexBytes(v.str)
	if !ok {
		return nil, rejectf("index", "invalid lowercase 0x hex string")
	}
	return b, nil
}

func expectHex20(v jsonValue) ([20]byte, error) {
	var zero [20]byte
	if v.kind != jsonString {
		return zero, rejectf("index", "expected address hex string")
	}
	out, ok := parseHex20(v.str)
	if !ok {
		return zero, rejectf("index", "invalid 20-byte address")
	}
	return out, nil
}

func expectHex32(v jsonValue) ([32]byte, error) {
	var zero [32]byte
	if v.kind != jsonString {
		return zero, rejectf("index", "expected 32-byte hex string")
	}
	out, ok := parseHex32(v.str)
	if !ok {
		return zero, rejectf("index", "invalid 32-byte hex string")
	}
	return out, nil
}

func parseHexBytes(s string) ([]byte, bool) {
	if len(s) < 2 || s[0] != '0' || s[1] != 'x' || (len(s)-2)%2 != 0 {
		return nil, false
	}
	n := (len(s) - 2) / 2
	out := make([]byte, n)
	for i := 0; i < n; i++ {
		hi, ok1 := lowerHexNibble(s[2+2*i])
		lo, ok2 := lowerHexNibble(s[2+2*i+1])
		if !ok1 || !ok2 {
			return nil, false
		}
		out[i] = (hi << 4) | lo
	}
	return out, true
}

func parseHex20(s string) ([20]byte, bool) {
	var out [20]byte
	if len(s) != 42 {
		return out, false
	}
	b, ok := parseHexBytes(s)
	if !ok {
		return out, false
	}
	copy(out[:], b)
	return out, true
}

func parseHex32(s string) ([32]byte, bool) {
	var out [32]byte
	if len(s) != 66 {
		return out, false
	}
	b, ok := parseHexBytes(s)
	if !ok {
		return out, false
	}
	copy(out[:], b)
	return out, true
}

func lowerHexNibble(c byte) (byte, bool) {
	switch {
	case c >= '0' && c <= '9':
		return c - '0', true
	case c >= 'a' && c <= 'f':
		return c - 'a' + 10, true
	default:
		return 0, false
	}
}

func parseDecimalUint256(s string) (*big.Int, bool) {
	if len(s) == 0 {
		return nil, false
	}
	if len(s) > 1 && s[0] == '0' {
		return nil, false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return nil, false
		}
	}
	v, ok := new(big.Int).SetString(s, 10)
	if !ok || v.Sign() < 0 || v.Cmp(twoPow256) >= 0 {
		return nil, false
	}
	return v, true
}
