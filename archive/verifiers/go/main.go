package main

import (
	"bufio"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"strings"
)

type rejectError struct {
	class string
	msg   string
}

func (e *rejectError) Error() string {
	return fmt.Sprintf("reject %s %s", e.class, e.msg)
}

func rejectf(class, format string, args ...any) error {
	msg := fmt.Sprintf(format, args...)
	msg = strings.ReplaceAll(msg, "\n", " ")
	msg = strings.ReplaceAll(msg, "\r", " ")
	return &rejectError{class: class, msg: msg}
}

func main() {
	bundlePath, outDir, hasOut, err := parseCLI(os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}

	if err := runVerify(bundlePath, outDir, hasOut); err != nil {
		var re *rejectError
		if errors.As(err, &re) {
			if _, werr := fmt.Fprintf(os.Stdout, "reject %s %s\n", re.class, re.msg); werr != nil {
				os.Exit(2)
			}
			os.Exit(1)
		}
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
}

func parseCLI(args []string) (string, string, bool, error) {
	var pos []string
	var outDir string
	hasOut := false
	flagsDone := false

	for i := 0; i < len(args); i++ {
		a := args[i]
		if !flagsDone && a == "--" {
			flagsDone = true
			continue
		}
		if !flagsDone && a == "--out" {
			if hasOut || i+1 >= len(args) {
				return "", "", false, errors.New("usage: abxverify <bundle file> [--out DIR]")
			}
			i++
			outDir = args[i]
			if outDir == "" {
				return "", "", false, errors.New("--out directory must not be empty")
			}
			hasOut = true
			continue
		}
		if !flagsDone && strings.HasPrefix(a, "--out=") {
			if hasOut {
				return "", "", false, errors.New("duplicate --out flag")
			}
			outDir = strings.TrimPrefix(a, "--out=")
			if outDir == "" {
				return "", "", false, errors.New("--out directory must not be empty")
			}
			hasOut = true
			continue
		}
		if !flagsDone && strings.HasPrefix(a, "-") {
			return "", "", false, fmt.Errorf("unknown flag: %s", a)
		}
		pos = append(pos, a)
	}

	if len(pos) != 1 {
		return "", "", false, errors.New("usage: abxverify <bundle file> [--out DIR]")
	}
	return pos[0], outDir, hasOut, nil
}

func runVerify(bundlePath, outDir string, hasOut bool) error {
	f, err := os.Open(bundlePath)
	if err != nil {
		return err
	}
	defer f.Close()

	fi, err := f.Stat()
	if err != nil {
		return err
	}
	if fi.IsDir() {
		return fmt.Errorf("%s is a directory", bundlePath)
	}

	indexData, rawOrder, rawMap, err := readContainer(f)
	if err != nil {
		return err
	}

	rootVal, hasDupKey, err := parseJSON(indexData)
	if err != nil {
		return err
	}

	if err := verifyLinkWalk(rootVal, rawOrder, rawMap); err != nil {
		return err
	}

	if hasDupKey {
		return rejectf("index", "duplicate key in JSON object")
	}

	idx, err := decodeIndex(rootVal, rawMap)
	if err != nil {
		return err
	}

	bindRes, err := verifyBindingAndParam(idx)
	if err != nil {
		return err
	}

	listing, err := verifyContent(idx, hasOut)
	if err != nil {
		return err
	}

	if hasOut {
		if err := writeOutputFiles(outDir, listing.items); err != nil {
			return err
		}
	}

	w := bufio.NewWriterSize(os.Stdout, 64*1024)
	fmt.Fprint(w, "abx-archive/1\n")
	fmt.Fprintf(w, "project %d %s %s %s\n",
		idx.project.chain,
		formatHex20(idx.project.org),
		idx.project.tokenStr,
		idx.project.key,
	)
	fmt.Fprintf(w, "root %s\n", formatHex32(idx.root))

	switch idx.proof.kind {
	case "ethereum":
		fmt.Fprintf(w, "anchor %d %s\n", bindRes.anchorNum, formatHex32(bindRes.anchorHash))
	case "base", "arbitrum":
		fmt.Fprintf(w, "anchor %d %s\n", bindRes.anchorNum, formatHex32(bindRes.anchorHash))
		fmt.Fprintf(w, "l2 %d %s %s\n", bindRes.l2Num, formatHex32(bindRes.l2Hash), bindRes.l2Status)
	case "agreed":
		fmt.Fprintf(w, "not proved agreed %d %s\n", idx.proof.block, strings.Join(idx.proof.endpoints, ","))
	case "logged":
		fmt.Fprintf(w, "not proved logged %d %s\n", idx.proof.block, formatHex32(idx.proof.tx))
	}

	fmt.Fprintf(w, "store %s\n", idx.content.store)
	for _, it := range listing.items {
		fmt.Fprintf(w, "%s\n", it.line)
	}
	fmt.Fprintf(w, "end %d %d\n", listing.fileCount, listing.totalBytes)
	return w.Flush()
}

func formatHex20(b [20]byte) string {
	return "0x" + hex.EncodeToString(b[:])
}

func formatHex32(b [32]byte) string {
	return "0x" + hex.EncodeToString(b[:])
}
