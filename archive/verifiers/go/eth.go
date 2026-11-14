package main

import (
	"bytes"
	"encoding/binary"
	"math/big"
)

var (
	collectionCodeHash = mustHex32("0x52fca2e6744bf60088e9313fac37cda721b968eb7e77c243975ab36b49b0d34c")
	eip1967ImplSlot    = mustHex32("0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc")

	basePortal       = mustHex20("0x49048044d57e1c92a77f79988d21fa8faf74e97e")
	basePortalImpl   = mustHex20("0x03863ab7f64b733cff85c8ff44a86601c568ca70")
	baseRegistry     = mustHex20("0x909f6cf47ed12f010a796527f562bfc26c7f4e72")
	baseRegistryImpl = mustHex20("0x4483f964f6711cb55f633820ed174e780369b99d")
	baseFactory      = mustHex20("0x43edb88c4b80fdd2adff2412a7bebf9df42cb40e")
	baseFactoryImpl  = mustHex20("0x94eab8f73fd83407d26c006d159923760d483029")
	baseGameImpl     = mustHex20("0xc08b8ffaf04abb1d7013b74a0e57eccbd7fa5a70")
	basePasser       = mustHex20("0x4200000000000000000000000000000000000016")
	baseGameHead     = mustHexBytes("0x36602c57343d527f9e4ac34f21c619cefc926c8bd93b54bf5a39c7ab2127a895af1cc0691d7e3dff593da1005b363d3d373d3d3d3d61030a806062363936013d73c08b8ffaf04abb1d7013b74a0e57eccbd7fa5a705af43d3d93803e606057fd5bf3")

	arbRollup        = mustHex20("0x4dceb440657f21083db8add07665f8ddbe1dcfc0")
	arbPrimaryImpl   = mustHex20("0x7fc126ff51183a78c5e0437467f325f661d8df17")
	arbSecondarySlot = mustHex32("0x2b1dbce74324248c222f0ec2d5ed7bd323cfc425b336f0253c5ccfda7265546d")
	arbSecondaryImpl = mustHex20("0x6490ba0a60cc7d3a59c9eee135d9eed24553a60d")

	emptyTrieRoot = keccak256([]byte{0x80})
)

func mustHex20(s string) [20]byte {
	v, ok := parseHex20(s)
	if !ok {
		panic("bad constant " + s)
	}
	return v
}

func mustHex32(s string) [32]byte {
	v, ok := parseHex32(s)
	if !ok {
		panic("bad constant " + s)
	}
	return v
}

func mustHexBytes(s string) []byte {
	v, ok := parseHexBytes(s)
	if !ok {
		panic("bad constant " + s)
	}
	return v
}

type rlpItem struct {
	isList bool
	str    []byte
	elems  []rlpItem
	raw    []byte
}

const maxRLPDepth = 128

func decodeRLP(buf []byte) (rlpItem, error) {
	if len(buf) == 0 {
		return rlpItem{}, rejectf("proof", "empty RLP input")
	}
	item, consumed, err := decodeRLPAt(buf, 0)
	if err != nil {
		return rlpItem{}, err
	}
	if consumed != len(buf) {
		return rlpItem{}, rejectf("proof", "trailing bytes after outermost RLP item")
	}
	return item, nil
}

func decodeRLPAt(buf []byte, depth int) (rlpItem, int, error) {
	if depth > maxRLPDepth {
		return rlpItem{}, 0, rejectf("proof", "RLP nesting too deep")
	}
	if len(buf) == 0 {
		return rlpItem{}, 0, rejectf("proof", "unexpected end of RLP")
	}
	b := buf[0]
	switch {
	case b < 0x80:
		return rlpItem{isList: false, str: buf[0:1], raw: buf[0:1]}, 1, nil

	case b <= 0xb7:
		length := int(b - 0x80)
		if len(buf) < 1+length {
			return rlpItem{}, 0, rejectf("proof", "truncated RLP short string")
		}
		if length == 1 && buf[1] < 0x80 {
			return rlpItem{}, 0, rejectf("proof", "non-canonical single-byte RLP string")
		}
		return rlpItem{isList: false, str: buf[1 : 1+length], raw: buf[0 : 1+length]}, 1 + length, nil

	case b <= 0xbf:
		ll := int(b - 0xb7)
		if len(buf) < 1+ll {
			return rlpItem{}, 0, rejectf("proof", "truncated RLP string length")
		}
		length, err := decodeRLPLength(buf[1 : 1+ll])
		if err != nil {
			return rlpItem{}, 0, err
		}
		rem := uint64(len(buf) - 1 - ll)
		if length > rem {
			return rlpItem{}, 0, rejectf("proof", "truncated RLP long string")
		}
		end := 1 + ll + int(length)
		return rlpItem{isList: false, str: buf[1+ll : end], raw: buf[0:end]}, end, nil

	case b <= 0xf7:
		length := int(b - 0xc0)
		if len(buf) < 1+length {
			return rlpItem{}, 0, rejectf("proof", "truncated RLP short list")
		}
		elems, err := decodeRLPListPayload(buf[1:1+length], depth+1)
		if err != nil {
			return rlpItem{}, 0, err
		}
		return rlpItem{isList: true, elems: elems, raw: buf[0 : 1+length]}, 1 + length, nil

	default:
		ll := int(b - 0xf7)
		if len(buf) < 1+ll {
			return rlpItem{}, 0, rejectf("proof", "truncated RLP list length")
		}
		length, err := decodeRLPLength(buf[1 : 1+ll])
		if err != nil {
			return rlpItem{}, 0, err
		}
		rem := uint64(len(buf) - 1 - ll)
		if length > rem {
			return rlpItem{}, 0, rejectf("proof", "truncated RLP long list")
		}
		end := 1 + ll + int(length)
		elems, err := decodeRLPListPayload(buf[1+ll:end], depth+1)
		if err != nil {
			return rlpItem{}, 0, err
		}
		return rlpItem{isList: true, elems: elems, raw: buf[0:end]}, end, nil
	}
}

func decodeRLPLength(lenBytes []byte) (uint64, error) {
	if len(lenBytes) == 0 || lenBytes[0] == 0 {
		return 0, rejectf("proof", "leading zero in RLP length")
	}
	var v uint64
	for _, b := range lenBytes {
		v = (v << 8) | uint64(b)
	}
	if v <= 55 {
		return 0, rejectf("proof", "RLP long-form length not over 55")
	}
	return v, nil
}

func decodeRLPListPayload(payload []byte, depth int) ([]rlpItem, error) {
	var elems []rlpItem
	pos := 0
	for pos < len(payload) {
		it, n, err := decodeRLPAt(payload[pos:], depth)
		if err != nil {
			return nil, err
		}
		elems = append(elems, it)
		pos += n
	}
	return elems, nil
}

func validateRLPInteger(it rlpItem) error {
	if it.isList {
		return rejectf("proof", "expected RLP integer string, got list")
	}
	if len(it.str) > 32 {
		return rejectf("proof", "RLP integer exceeds 32 bytes")
	}
	if len(it.str) > 0 && it.str[0] == 0 {
		return rejectf("proof", "leading zero in RLP integer")
	}
	return nil
}

func rlpIntToWord(it rlpItem) ([32]byte, error) {
	var out [32]byte
	if err := validateRLPInteger(it); err != nil {
		return out, err
	}
	if len(it.str) == 0 {
		return out, rejectf("proof", "storage word must be 1 to 32 bytes")
	}
	copy(out[32-len(it.str):], it.str)
	return out, nil
}

func rlpIntToUint53(it rlpItem) (uint64, error) {
	if err := validateRLPInteger(it); err != nil {
		return 0, err
	}
	if len(it.str) > 7 {
		return 0, rejectf("proof", "RLP integer reaches or exceeds 2^53")
	}
	var v uint64
	for _, b := range it.str {
		v = (v << 8) | uint64(b)
	}
	if v > maxSafeInt {
		return 0, rejectf("proof", "RLP integer reaches or exceeds 2^53")
	}
	return v, nil
}

type blockHeader struct {
	hash      [32]byte
	stateRoot [32]byte
	number    uint64
	timestamp uint64
}

func parseBlockHeader(raw []byte) (blockHeader, error) {
	it, err := decodeRLP(raw)
	if err != nil {
		return blockHeader{}, err
	}
	if !it.isList || len(it.elems) < 15 {
		return blockHeader{}, rejectf("proof", "header must be RLP list of at least 15 items")
	}
	for _, el := range it.elems {
		if el.isList {
			return blockHeader{}, rejectf("proof", "header item must be string")
		}
	}
	if len(it.elems[3].str) != 32 {
		return blockHeader{}, rejectf("proof", "header state root must be 32 bytes")
	}
	num, err := rlpIntToUint53(it.elems[8])
	if err != nil {
		return blockHeader{}, err
	}
	ts, err := rlpIntToUint53(it.elems[11])
	if err != nil {
		return blockHeader{}, err
	}
	return blockHeader{
		hash:      keccak256(raw),
		stateRoot: [32]byte(it.elems[3].str),
		number:    num,
		timestamp: ts,
	}, nil
}

func verifyMPTProof(root [32]byte, keyBytes []byte, proof [][]byte) ([]byte, bool, error) {
	if len(proof) > 64 {
		return nil, false, rejectf("proof", "proof exceeds 64 nodes")
	}
	if len(proof) == 0 {
		if root == emptyTrieRoot {
			return nil, false, nil
		}
		return nil, false, rejectf("proof", "empty proof for non-empty trie root")
	}

	keyHash := keccak256(keyBytes)
	var keyNibbles [64]byte
	for i := 0; i < 32; i++ {
		keyNibbles[2*i] = keyHash[i] >> 4
		keyNibbles[2*i+1] = keyHash[i] & 0x0f
	}

	if keccak256(proof[0]) != root {
		return nil, false, rejectf("proof", "first proof node hash does not match root")
	}
	curNode, err := decodeRLP(proof[0])
	if err != nil {
		return nil, false, err
	}
	proofIdx := 1
	pos := 0

	for steps := 0; steps <= 65; steps++ {
		if !curNode.isList {
			return nil, false, rejectf("proof", "trie node is not an RLP list")
		}
		switch len(curNode.elems) {
		case 17:
			for i := 0; i < 16; i++ {
				if !isValidBranchChild(curNode.elems[i]) {
					return nil, false, rejectf("proof", "invalid child reference in branch node")
				}
			}
			if curNode.elems[16].isList || len(curNode.elems[16].str) != 0 {
				return nil, false, rejectf("proof", "value at branch node")
			}
			if pos == 64 {
				if proofIdx != len(proof) {
					return nil, false, rejectf("proof", "leftover nodes in proof")
				}
				return nil, false, nil
			}
			nib := keyNibbles[pos]
			pos++
			child := curNode.elems[nib]
			if !child.isList && len(child.str) == 0 {
				if proofIdx != len(proof) {
					return nil, false, rejectf("proof", "leftover nodes in proof")
				}
				return nil, false, nil
			}
			if child.isList {
				curNode = child
				continue
			}
			if proofIdx >= len(proof) {
				return nil, false, rejectf("proof", "missing child node in proof")
			}
			nextRaw := proof[proofIdx]
			proofIdx++
			if keccak256(nextRaw) != [32]byte(child.str) {
				return nil, false, rejectf("proof", "child node hash mismatch")
			}
			curNode, err = decodeRLP(nextRaw)
			if err != nil {
				return nil, false, err
			}

		case 2:
			isLeaf, nodeNibbles, err := decodeHexPrefix(curNode.elems[0])
			if err != nil {
				return nil, false, err
			}
			if isLeaf {
				if curNode.elems[1].isList || len(curNode.elems[1].str) == 0 {
					return nil, false, rejectf("proof", "leaf value must be non-empty RLP string")
				}
				if proofIdx != len(proof) {
					return nil, false, rejectf("proof", "leftover nodes in proof")
				}
				if bytes.Equal(nodeNibbles, keyNibbles[pos:]) {
					return curNode.elems[1].str, true, nil
				}
				return nil, false, nil
			}

			if len(nodeNibbles) == 0 {
				return nil, false, rejectf("proof", "empty extension node path")
			}
			child := curNode.elems[1]
			if !isValidExtensionChild(child) {
				return nil, false, rejectf("proof", "invalid child reference in extension node")
			}
			rem := keyNibbles[pos:]
			if len(nodeNibbles) > len(rem) || !bytes.Equal(nodeNibbles, rem[:len(nodeNibbles)]) {
				if proofIdx != len(proof) {
					return nil, false, rejectf("proof", "leftover nodes in proof")
				}
				return nil, false, nil
			}
			pos += len(nodeNibbles)
			if child.isList {
				curNode = child
				continue
			}
			if proofIdx >= len(proof) {
				return nil, false, rejectf("proof", "missing extension child node in proof")
			}
			nextRaw := proof[proofIdx]
			proofIdx++
			if keccak256(nextRaw) != [32]byte(child.str) {
				return nil, false, rejectf("proof", "extension child hash mismatch")
			}
			curNode, err = decodeRLP(nextRaw)
			if err != nil {
				return nil, false, err
			}

		default:
			return nil, false, rejectf("proof", "trie node must have 2 or 17 items")
		}
	}
	return nil, false, rejectf("proof", "trie walk exceeded maximum depth")
}

func isValidBranchChild(it rlpItem) bool {
	if it.isList {
		return len(it.raw) < 32 && (len(it.elems) == 2 || len(it.elems) == 17)
	}
	return len(it.str) == 0 || len(it.str) == 32
}

func isValidExtensionChild(it rlpItem) bool {
	if it.isList {
		return len(it.raw) < 32 && (len(it.elems) == 2 || len(it.elems) == 17)
	}
	return len(it.str) == 32
}

func decodeHexPrefix(it rlpItem) (bool, []byte, error) {
	if it.isList || len(it.str) == 0 {
		return false, nil, rejectf("proof", "invalid hex-prefix path item")
	}
	hp := it.str
	flag := hp[0] >> 4
	low := hp[0] & 0x0f
	if flag > 3 {
		return false, nil, rejectf("proof", "invalid hex-prefix flag")
	}
	if (flag == 0 || flag == 2) && low != 0 {
		return false, nil, rejectf("proof", "non-zero low nibble with even hex-prefix flag")
	}
	isLeaf := flag >= 2
	odd := (flag & 1) == 1
	n := 2 * (len(hp) - 1)
	if odd {
		n++
	}
	nibbles := make([]byte, 0, n)
	if odd {
		nibbles = append(nibbles, low)
	}
	for i := 1; i < len(hp); i++ {
		nibbles = append(nibbles, hp[i]>>4, hp[i]&0x0f)
	}
	return isLeaf, nibbles, nil
}

type verifiedAccount struct {
	exists      bool
	storageRoot [32]byte
	codeHash    [32]byte
	slots       map[[32]byte][32]byte
}

type verifiedState struct {
	header blockHeader
	accs   map[[20]byte]*verifiedAccount
	codes  [][]byte
}

func verifyStateEvidence(ev chainStateEvidence) (*verifiedState, error) {
	hdr, err := parseBlockHeader(ev.header)
	if err != nil {
		return nil, err
	}
	accs := make(map[[20]byte]*verifiedAccount, len(ev.accounts))
	for _, ae := range ev.accounts {
		if _, dup := accs[ae.address]; dup {
			return nil, rejectf("proof", "duplicate address in accounts evidence")
		}
		valBytes, present, err := verifyMPTProof(hdr.stateRoot, ae.address[:], ae.proof)
		if err != nil {
			return nil, err
		}
		if !present {
			if len(ae.storage) > 0 {
				return nil, rejectf("proof", "storage evidence given for absent account")
			}
			accs[ae.address] = &verifiedAccount{exists: false}
			continue
		}
		accRLP, err := decodeRLP(valBytes)
		if err != nil {
			return nil, err
		}
		if !accRLP.isList || len(accRLP.elems) != 4 {
			return nil, rejectf("proof", "account RLP must be 4-item list")
		}
		if err := validateRLPInteger(accRLP.elems[0]); err != nil {
			return nil, err
		}
		if err := validateRLPInteger(accRLP.elems[1]); err != nil {
			return nil, err
		}
		if accRLP.elems[2].isList || len(accRLP.elems[2].str) != 32 {
			return nil, rejectf("proof", "account storageRoot must be 32-byte string")
		}
		if accRLP.elems[3].isList || len(accRLP.elems[3].str) != 32 {
			return nil, rejectf("proof", "account codeHash must be 32-byte string")
		}
		storageRoot := [32]byte(accRLP.elems[2].str)
		codeHash := [32]byte(accRLP.elems[3].str)

		slots := make(map[[32]byte][32]byte, len(ae.storage))
		for _, se := range ae.storage {
			if _, dup := slots[se.slot]; dup {
				return nil, rejectf("proof", "duplicate slot under account")
			}
			sBytes, sPresent, err := verifyMPTProof(storageRoot, se.slot[:], se.proof)
			if err != nil {
				return nil, err
			}
			if !sPresent {
				slots[se.slot] = [32]byte{}
				continue
			}
			wordItem, err := decodeRLP(sBytes)
			if err != nil {
				return nil, err
			}
			w, err := rlpIntToWord(wordItem)
			if err != nil {
				return nil, err
			}
			slots[se.slot] = w
		}
		accs[ae.address] = &verifiedAccount{
			exists:      true,
			storageRoot: storageRoot,
			codeHash:    codeHash,
			slots:       slots,
		}
	}
	return &verifiedState{header: hdr, accs: accs, codes: ev.codes}, nil
}

func (s *verifiedState) getAccount(addr [20]byte) (*verifiedAccount, error) {
	acc, ok := s.accs[addr]
	if !ok {
		return nil, rejectf("proof", "missing account evidence")
	}
	return acc, nil
}

func (s *verifiedState) getWord(addr [20]byte, slot [32]byte) ([32]byte, error) {
	acc, err := s.getAccount(addr)
	if err != nil {
		return [32]byte{}, err
	}
	if !acc.exists {
		return [32]byte{}, nil
	}
	w, ok := acc.slots[slot]
	if !ok {
		return [32]byte{}, rejectf("proof", "missing storage slot evidence")
	}
	return w, nil
}

func (s *verifiedState) getCode(addr [20]byte) ([]byte, error) {
	acc, err := s.getAccount(addr)
	if err != nil {
		return nil, err
	}
	for _, code := range s.codes {
		if keccak256(code) == acc.codeHash {
			return code, nil
		}
	}
	return nil, rejectf("proof", "missing matching code in codes")
}

func wordUint64(n uint64) [32]byte {
	var w [32]byte
	binary.BigEndian.PutUint64(w[24:32], n)
	return w
}

func wordAddress(addr [20]byte) [32]byte {
	var w [32]byte
	copy(w[12:32], addr[:])
	return w
}

func wordBigInt(v *big.Int) [32]byte {
	var w [32]byte
	b := v.Bytes()
	copy(w[32-len(b):], b)
	return w
}

func wordNamesAddress(w [32]byte, addr [20]byte) bool {
	return [20]byte(w[12:32]) == addr
}

func computeParamSlots(token *big.Int, key string) ([32]byte, [32]byte) {
	nsHash := keccak256([]byte("abx.storage.params"))
	nsMinusOne := new(big.Int).Sub(new(big.Int).SetBytes(nsHash[:]), big.NewInt(1))
	nsWord := wordBigInt(nsMinusOne)
	base := keccak256(nsWord[:])
	base[31] = 0

	var keyWord [32]byte
	copy(keyWord[:], key)

	tokenWord := wordBigInt(token)
	inner := keccak256(tokenWord[:], base[:])
	valueSlot := keccak256(keyWord[:], inner[:])

	flagsInt := new(big.Int).Add(new(big.Int).SetBytes(valueSlot[:]), big.NewInt(1))
	flagsInt.Mod(flagsInt, twoPow256)
	flagsSlot := wordBigInt(flagsInt)
	return valueSlot, flagsSlot
}

func verifyParamRule(st *verifiedState, proj projectInfo, expectedRoot [32]byte) error {
	orgAcc, err := st.getAccount(proj.org)
	if err != nil {
		return err
	}
	if !orgAcc.exists || orgAcc.codeHash != collectionCodeHash {
		return rejectf("param", "org account missing or wrong collection code hash")
	}

	valueSlot, flagsSlot := computeParamSlots(proj.tokenInt, proj.key)
	flags, err := st.getWord(proj.org, flagsSlot)
	if err != nil {
		return err
	}
	val, err := st.getWord(proj.org, valueSlot)
	if err != nil {
		return err
	}

	if flags != wordUint64(0x0100) {
		return rejectf("param", "parameter flags is not 0x0100")
	}
	if val != expectedRoot {
		return rejectf("param", "parameter value does not match bundle root")
	}
	return nil
}

type bindingResult struct {
	hasAnchor  bool
	anchorNum  uint64
	anchorHash [32]byte
	hasL2      bool
	l2Num      uint64
	l2Hash     [32]byte
	l2Status   string
}

func verifyBindingAndParam(idx *bundleIndex) (bindingResult, error) {
	p := &idx.proof
	switch p.kind {
	case "agreed", "logged":
		return bindingResult{}, nil

	case "ethereum":
		st, err := verifyStateEvidence(chainStateEvidence{
			header:   p.header,
			accounts: p.accounts,
		})
		if err != nil {
			return bindingResult{}, err
		}
		if err := verifyParamRule(st, idx.project, idx.root); err != nil {
			return bindingResult{}, err
		}
		return bindingResult{
			hasAnchor:  true,
			anchorNum:  st.header.number,
			anchorHash: st.header.hash,
		}, nil

	case "base":
		l1, err := verifyStateEvidence(p.l1)
		if err != nil {
			return bindingResult{}, err
		}
		l2, err := verifyStateEvidence(p.l2)
		if err != nil {
			return bindingResult{}, err
		}

		portalImplW, err := l1.getWord(basePortal, eip1967ImplSlot)
		if err != nil {
			return bindingResult{}, err
		}
		portalRegW, err := l1.getWord(basePortal, wordUint64(62))
		if err != nil {
			return bindingResult{}, err
		}
		if !wordNamesAddress(portalImplW, basePortalImpl) || !wordNamesAddress(portalRegW, baseRegistry) {
			return bindingResult{}, rejectf("binding", "Base portal implementation or registry mismatch")
		}

		regImplW, err := l1.getWord(baseRegistry, eip1967ImplSlot)
		if err != nil {
			return bindingResult{}, err
		}
		regFactW, err := l1.getWord(baseRegistry, wordUint64(1))
		if err != nil {
			return bindingResult{}, err
		}
		r6, err := l1.getWord(baseRegistry, wordUint64(6))
		if err != nil {
			return bindingResult{}, err
		}
		if !wordNamesAddress(regImplW, baseRegistryImpl) || !wordNamesAddress(regFactW, baseFactory) {
			return bindingResult{}, rejectf("binding", "Base registry implementation or factory mismatch")
		}
		if binary.BigEndian.Uint32(r6[28:32]) != 621 {
			return bindingResult{}, rejectf("binding", "Base registry respected game type is not 621")
		}
		retirement := binary.BigEndian.Uint64(r6[20:28])

		factImplW, err := l1.getWord(baseFactory, eip1967ImplSlot)
		if err != nil {
			return bindingResult{}, err
		}
		w621 := wordUint64(621)
		w101 := wordUint64(101)
		gameImplSlot := keccak256(w621[:], w101[:])
		gameImplW, err := l1.getWord(baseFactory, gameImplSlot)
		if err != nil {
			return bindingResult{}, err
		}
		if !wordNamesAddress(factImplW, baseFactoryImpl) || !wordNamesAddress(gameImplW, baseGameImpl) {
			return bindingResult{}, rejectf("binding", "Base factory or game implementation mismatch")
		}

		gameAcc, err := l1.getAccount(p.game)
		if err != nil {
			return bindingResult{}, err
		}
		if !gameAcc.exists {
			return bindingResult{}, rejectf("binding", "Base dispute game account does not exist")
		}
		code, err := l1.getCode(p.game)
		if err != nil {
			return bindingResult{}, err
		}
		if len(code) < 98+136+2 || !bytes.HasPrefix(code, baseGameHead) {
			return bindingResult{}, rejectf("binding", "Base dispute game bytecode invalid")
		}
		args := code[98 : len(code)-2]
		rootClaim := [32]byte(args[20:52])
		extra := args[84:]
		for i := 0; i < 24; i++ {
			if extra[i] != 0 {
				return bindingResult{}, rejectf("binding", "Base game l2Block exceeds 2^53-1")
			}
		}
		l2Block := binary.BigEndian.Uint64(extra[24:32])
		if l2Block > maxSafeInt {
			return bindingResult{}, rejectf("binding", "Base game l2Block exceeds 2^53-1")
		}

		w96 := wordUint64(96)
		wExtraLen := wordUint64(uint64(len(extra)))
		pad := make([]byte, (32-(len(extra)%32))%32)
		uuid := keccak256(w621[:], rootClaim[:], w96[:], wExtraLen[:], extra, pad)
		w103 := wordUint64(103)
		recSlot := keccak256(uuid[:], w103[:])
		rec, err := l1.getWord(baseFactory, recSlot)
		if err != nil {
			return bindingResult{}, err
		}
		if !wordNamesAddress(rec, p.game) || binary.BigEndian.Uint32(rec[0:4]) != 621 {
			return bindingResult{}, rejectf("binding", "Base factory game record mismatch")
		}

		wGame := wordAddress(p.game)
		w5 := wordUint64(5)
		blSlot := keccak256(wGame[:], w5[:])
		blVal, err := l1.getWord(baseRegistry, blSlot)
		if err != nil {
			return bindingResult{}, err
		}
		if blVal != ([32]byte{}) {
			return bindingResult{}, rejectf("binding", "Base dispute game is blacklisted")
		}

		s0, err := l1.getWord(p.game, wordUint64(0))
		if err != nil {
			return bindingResult{}, err
		}
		createdAt := binary.BigEndian.Uint64(s0[24:32])
		status := s0[15]
		respected := s0[13]
		if respected == 0 || createdAt <= retirement {
			return bindingResult{}, rejectf("binding", "Base game not respected or retired")
		}
		s7, err := l1.getWord(p.game, wordUint64(7))
		if err != nil {
			return bindingResult{}, err
		}
		proofCount := s7[23]

		if p.final {
			anchorGameW, err := l1.getWord(baseRegistry, wordUint64(2))
			if err != nil {
				return bindingResult{}, err
			}
			if !wordNamesAddress(anchorGameW, p.game) || status != 2 {
				return bindingResult{}, rejectf("binding", "Base final game mismatch")
			}
		} else {
			if (status != 0 && status != 2) || proofCount < 1 {
				return bindingResult{}, rejectf("binding", "Base claimed game invalid status or proofCount")
			}
		}

		if l2.header.number != l2Block {
			return bindingResult{}, rejectf("binding", "Base L2 block number mismatch")
		}
		passerAcc, err := l2.getAccount(basePasser)
		if err != nil {
			return bindingResult{}, err
		}
		if !passerAcc.exists {
			return bindingResult{}, rejectf("binding", "Base L2 message passer account missing")
		}
		w0 := wordUint64(0)
		outputRoot := keccak256(w0[:], l2.header.stateRoot[:], passerAcc.storageRoot[:], l2.header.hash[:])
		if outputRoot != rootClaim {
			return bindingResult{}, rejectf("binding", "Base output root does not match rootClaim")
		}

		if err := verifyParamRule(l2, idx.project, idx.root); err != nil {
			return bindingResult{}, err
		}

		l2Status := "claimed"
		if p.final {
			l2Status = "final"
		}
		return bindingResult{
			hasAnchor:  true,
			anchorNum:  l1.header.number,
			anchorHash: l1.header.hash,
			hasL2:      true,
			l2Num:      l2.header.number,
			l2Hash:     l2.header.hash,
			l2Status:   l2Status,
		}, nil

	case "arbitrum":
		l1, err := verifyStateEvidence(p.l1)
		if err != nil {
			return bindingResult{}, err
		}
		l2, err := verifyStateEvidence(p.l2)
		if err != nil {
			return bindingResult{}, err
		}

		primW, err := l1.getWord(arbRollup, eip1967ImplSlot)
		if err != nil {
			return bindingResult{}, err
		}
		secW, err := l1.getWord(arbRollup, arbSecondarySlot)
		if err != nil {
			return bindingResult{}, err
		}
		if !wordNamesAddress(primW, arbPrimaryImpl) || !wordNamesAddress(secW, arbSecondaryImpl) {
			return bindingResult{}, rejectf("binding", "Arbitrum rollup implementation mismatch")
		}

		assertion, err := l1.getWord(arbRollup, wordUint64(116))
		if err != nil {
			return bindingResult{}, err
		}
		if assertion == ([32]byte{}) {
			return bindingResult{}, rejectf("binding", "Arbitrum assertion is zero")
		}
		w117 := wordUint64(117)
		nodeSlot := keccak256(assertion[:], w117[:])
		node, err := l1.getWord(arbRollup, nodeSlot)
		if err != nil {
			return bindingResult{}, err
		}
		createdAt := binary.BigEndian.Uint64(node[8:16])
		if node[6] != 2 || createdAt < 1 || createdAt > l1.header.number {
			return bindingResult{}, rejectf("binding", "Arbitrum assertion node not confirmed or invalid createdAt")
		}

		data := p.log.data
		if len(data)%32 != 0 || len(data) < 20*32 || len(data) > 40*32 {
			return bindingResult{}, rejectf("binding", "Arbitrum log.data must be 20 to 40 words")
		}
		afterHash := keccak256(data[13*32 : 19*32])
		acc := data[19*32 : 20*32]
		gotAssertion := keccak256(p.log.parent[:], afterHash[:], acc)
		if gotAssertion != assertion {
			return bindingResult{}, rejectf("binding", "Arbitrum log does not hash to assertion")
		}
		blockHash := [32]byte(data[13*32 : 14*32])
		if l2.header.hash != blockHash {
			return bindingResult{}, rejectf("binding", "Arbitrum L2 block hash mismatch")
		}

		if err := verifyParamRule(l2, idx.project, idx.root); err != nil {
			return bindingResult{}, err
		}

		return bindingResult{
			hasAnchor:  true,
			anchorNum:  l1.header.number,
			anchorHash: l1.header.hash,
			hasL2:      true,
			l2Num:      l2.header.number,
			l2Hash:     l2.header.hash,
			l2Status:   "confirmed",
		}, nil

	default:
		return bindingResult{}, rejectf("index", "unknown proof kind")
	}
}
