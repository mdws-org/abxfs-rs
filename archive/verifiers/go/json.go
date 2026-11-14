package main

import (
	"bytes"
	"strconv"
	"strings"
	"unicode/utf8"
)

type jsonKind uint8

const (
	jsonNull jsonKind = iota
	jsonBool
	jsonNumber
	jsonString
	jsonArray
	jsonObject
)

type jsonMember struct {
	key string
	val jsonValue
}

type jsonValue struct {
	kind    jsonKind
	str     string
	boolean bool
	items   []jsonValue
	members []jsonMember
}

type jsonParser struct {
	data []byte
	pos  int
}

const (
	maxJSONDepth = 256
	maxSafeInt   = (uint64(1) << 53) - 1
)

func parseJSON(data []byte) (jsonValue, error) {
	if bytes.HasPrefix(data, []byte{0xef, 0xbb, 0xbf}) {
		return jsonValue{}, rejectf("index", "UTF-8 byte-order mark not allowed")
	}
	if !utf8.Valid(data) {
		return jsonValue{}, rejectf("index", "index block is not valid UTF-8")
	}
	p := &jsonParser{data: data}
	p.skipWS()
	val, err := p.parseValue(0)
	if err != nil {
		return jsonValue{}, err
	}
	p.skipWS()
	if p.pos != len(p.data) {
		return jsonValue{}, rejectf("index", "trailing data after JSON value")
	}
	return val, nil
}

func (p *jsonParser) skipWS() {
	for p.pos < len(p.data) {
		switch p.data[p.pos] {
		case ' ', '\t', '\n', '\r':
			p.pos++
		default:
			return
		}
	}
}

func (p *jsonParser) parseValue(depth int) (jsonValue, error) {
	if depth > maxJSONDepth {
		return jsonValue{}, rejectf("index", "JSON nesting too deep")
	}
	if p.pos >= len(p.data) {
		return jsonValue{}, rejectf("index", "unexpected end of JSON")
	}
	switch p.data[p.pos] {
	case '{':
		return p.parseObject(depth + 1)
	case '[':
		return p.parseArray(depth + 1)
	case '"':
		s, err := p.parseString()
		if err != nil {
			return jsonValue{}, err
		}
		return jsonValue{kind: jsonString, str: s}, nil
	case 't':
		if p.pos+4 <= len(p.data) && string(p.data[p.pos:p.pos+4]) == "true" {
			p.pos += 4
			return jsonValue{kind: jsonBool, boolean: true}, nil
		}
		return jsonValue{}, rejectf("index", "invalid JSON literal")
	case 'f':
		if p.pos+5 <= len(p.data) && string(p.data[p.pos:p.pos+5]) == "false" {
			p.pos += 5
			return jsonValue{kind: jsonBool, boolean: false}, nil
		}
		return jsonValue{}, rejectf("index", "invalid JSON literal")
	case 'n':
		if p.pos+4 <= len(p.data) && string(p.data[p.pos:p.pos+4]) == "null" {
			p.pos += 4
			return jsonValue{kind: jsonNull}, nil
		}
		return jsonValue{}, rejectf("index", "invalid JSON literal")
	default:
		if p.data[p.pos] == '-' || (p.data[p.pos] >= '0' && p.data[p.pos] <= '9') {
			return p.parseNumber()
		}
		return jsonValue{}, rejectf("index", "unexpected character in JSON")
	}
}

func (p *jsonParser) parseObject(depth int) (jsonValue, error) {
	p.pos++
	p.skipWS()
	if p.pos < len(p.data) && p.data[p.pos] == '}' {
		p.pos++
		return jsonValue{kind: jsonObject}, nil
	}
	var members []jsonMember
	seen := make(map[string]struct{})
	for {
		if p.pos >= len(p.data) || p.data[p.pos] != '"' {
			return jsonValue{}, rejectf("index", "expected object key")
		}
		key, err := p.parseString()
		if err != nil {
			return jsonValue{}, err
		}
		if _, dup := seen[key]; dup {
			return jsonValue{}, rejectf("index", "duplicate key in JSON object")
		}
		seen[key] = struct{}{}
		p.skipWS()
		if p.pos >= len(p.data) || p.data[p.pos] != ':' {
			return jsonValue{}, rejectf("index", "expected colon in object")
		}
		p.pos++
		p.skipWS()
		val, err := p.parseValue(depth)
		if err != nil {
			return jsonValue{}, err
		}
		members = append(members, jsonMember{key: key, val: val})
		p.skipWS()
		if p.pos >= len(p.data) {
			return jsonValue{}, rejectf("index", "unterminated JSON object")
		}
		if p.data[p.pos] == '}' {
			p.pos++
			return jsonValue{kind: jsonObject, members: members}, nil
		}
		if p.data[p.pos] != ',' {
			return jsonValue{}, rejectf("index", "expected comma or closing brace in object")
		}
		p.pos++
		p.skipWS()
	}
}

func (p *jsonParser) parseArray(depth int) (jsonValue, error) {
	p.pos++
	p.skipWS()
	if p.pos < len(p.data) && p.data[p.pos] == ']' {
		p.pos++
		return jsonValue{kind: jsonArray}, nil
	}
	var items []jsonValue
	for {
		val, err := p.parseValue(depth)
		if err != nil {
			return jsonValue{}, err
		}
		items = append(items, val)
		p.skipWS()
		if p.pos >= len(p.data) {
			return jsonValue{}, rejectf("index", "unterminated JSON array")
		}
		if p.data[p.pos] == ']' {
			p.pos++
			return jsonValue{kind: jsonArray, items: items}, nil
		}
		if p.data[p.pos] != ',' {
			return jsonValue{}, rejectf("index", "expected comma or closing bracket in array")
		}
		p.pos++
		p.skipWS()
	}
}

func (p *jsonParser) parseString() (string, error) {
	p.pos++
	start := p.pos
	hasEscape := false
	for p.pos < len(p.data) {
		b := p.data[p.pos]
		if b < 0x20 {
			return "", rejectf("index", "unescaped control character in JSON string")
		}
		if b == '"' {
			raw := p.data[start:p.pos]
			p.pos++
			if !hasEscape {
				return string(raw), nil
			}
			break
		}
		if b == '\\' {
			hasEscape = true
			p.pos += 2
			if p.pos > len(p.data) {
				return "", rejectf("index", "unterminated escape in JSON string")
			}
			continue
		}
		p.pos++
	}
	if !hasEscape {
		return "", rejectf("index", "unterminated JSON string")
	}

	p.pos = start
	var out []byte
	for p.pos < len(p.data) {
		b := p.data[p.pos]
		if b < 0x20 {
			return "", rejectf("index", "unescaped control character in JSON string")
		}
		if b == '"' {
			p.pos++
			return string(out), nil
		}
		if b != '\\' {
			out = append(out, b)
			p.pos++
			continue
		}
		p.pos++
		if p.pos >= len(p.data) {
			return "", rejectf("index", "unterminated escape in JSON string")
		}
		esc := p.data[p.pos]
		p.pos++
		switch esc {
		case '"', '\\', '/':
			out = append(out, esc)
		case 'b':
			out = append(out, '\b')
		case 'f':
			out = append(out, '\f')
		case 'n':
			out = append(out, '\n')
		case 'r':
			out = append(out, '\r')
		case 't':
			out = append(out, '\t')
		case 'u':
			u1, err := p.readHex4()
			if err != nil {
				return "", err
			}
			if u1 >= 0xdc00 && u1 <= 0xdfff {
				return "", rejectf("index", "unpaired low surrogate in JSON string")
			}
			var r rune
			if u1 >= 0xd800 && u1 <= 0xdbff {
				if p.pos+2 > len(p.data) || p.data[p.pos] != '\\' || p.data[p.pos+1] != 'u' {
					return "", rejectf("index", "unpaired high surrogate in JSON string")
				}
				p.pos += 2
				u2, err := p.readHex4()
				if err != nil {
					return "", err
				}
				if u2 < 0xdc00 || u2 > 0xdfff {
					return "", rejectf("index", "invalid surrogate pair in JSON string")
				}
				r = rune(0x10000 + ((int(u1)-0xd800)<<10) + (int(u2) - 0xdc00))
			} else {
				r = rune(u1)
			}
			var rbuf [4]byte
			n := utf8.EncodeRune(rbuf[:], r)
			out = append(out, rbuf[:n]...)
		default:
			return "", rejectf("index", "invalid escape character in JSON string")
		}
	}
	return "", rejectf("index", "unterminated JSON string")
}

func (p *jsonParser) readHex4() (uint16, error) {
	if p.pos+4 > len(p.data) {
		return 0, rejectf("index", "truncated unicode escape in JSON string")
	}
	var v uint16
	for i := 0; i < 4; i++ {
		c := p.data[p.pos+i]
		var nib uint16
		switch {
		case c >= '0' && c <= '9':
			nib = uint16(c - '0')
		case c >= 'a' && c <= 'f':
			nib = uint16(c-'a') + 10
		case c >= 'A' && c <= 'F':
			nib = uint16(c-'A') + 10
		default:
			return 0, rejectf("index", "invalid hex digit in unicode escape")
		}
		v = (v << 4) | nib
	}
	p.pos += 4
	return v, nil
}

func (p *jsonParser) parseNumber() (jsonValue, error) {
	start := p.pos
	if p.data[p.pos] == '-' {
		p.pos++
		if p.pos >= len(p.data) {
			return jsonValue{}, rejectf("index", "invalid JSON number")
		}
	}
	if p.data[p.pos] == '0' {
		p.pos++
		if p.pos < len(p.data) && p.data[p.pos] >= '0' && p.data[p.pos] <= '9' {
			return jsonValue{}, rejectf("index", "leading zero in JSON number")
		}
	} else if p.data[p.pos] >= '1' && p.data[p.pos] <= '9' {
		p.pos++
		for p.pos < len(p.data) && p.data[p.pos] >= '0' && p.data[p.pos] <= '9' {
			p.pos++
		}
	} else {
		return jsonValue{}, rejectf("index", "invalid JSON number")
	}
	if p.pos < len(p.data) && (p.data[p.pos] == '.' || p.data[p.pos] == 'e' || p.data[p.pos] == 'E') {
		return jsonValue{}, rejectf("index", "number with fraction or exponent not allowed")
	}
	return jsonValue{kind: jsonNumber, str: string(p.data[start:p.pos])}, nil
}

func parseIndexUint53(v jsonValue) (uint64, error) {
	if v.kind != jsonNumber {
		return 0, rejectf("index", "expected integer")
	}
	if strings.HasPrefix(v.str, "-") {
		return 0, rejectf("index", "negative integer not allowed")
	}
	val, err := strconv.ParseUint(v.str, 10, 64)
	if err != nil || val > maxSafeInt {
		return 0, rejectf("index", "integer exceeds 2^53-1")
	}
	return val, nil
}
