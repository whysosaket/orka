// Myers path selection follows jsdiff's array algorithm. Copyright (c) 2009-2015
// Kevin Decker. BSD-3-Clause; the complete notice is in licenses/jsdiff-BSD-3-Clause.txt.
package server

import (
	"sort"
	"strings"
)

type TextEdit struct {
	Start int      `json:"start"`
	End   int      `json:"end"`
	Lines []string `json:"lines"`
}
type diffComponent struct {
	count          int
	added, removed bool
	previous       *diffComponent
}
type diffPath struct {
	old  int
	last *diffComponent
}
type diffPart struct {
	added, removed bool
	lines          []string
}

func textLines(text string) []string {
	result := []string{}
	for len(text) > 0 {
		i := strings.IndexByte(text, '\n')
		if i < 0 {
			result = append(result, text)
			break
		}
		result = append(result, text[:i+1])
		text = text[i+1:]
	}
	return result
}
func addDiff(path *diffPath, added, removed bool, increment int) *diffPath {
	last := path.last
	next := &diffComponent{count: 1, added: added, removed: removed, previous: last}
	if last != nil && last.added == added && last.removed == removed {
		next.count = last.count + 1
		next.previous = last.previous
	}
	return &diffPath{old: path.old + increment, last: next}
}
func commonDiff(path *diffPath, old, next []string, diagonal int) int {
	newPos := path.old - diagonal
	count := 0
	for newPos+1 < len(next) && path.old+1 < len(old) && old[path.old+1] == next[newPos+1] {
		newPos++
		path.old++
		count++
	}
	if count > 0 {
		path.last = &diffComponent{count: count, previous: path.last}
	}
	return newPos
}
func diffValues(last *diffComponent, old, next []string) []diffPart {
	components := []*diffComponent{}
	for c := last; c != nil; c = c.previous {
		components = append(components, c)
	}
	parts := []diffPart{}
	o, n := 0, 0
	for i := len(components) - 1; i >= 0; i-- {
		c := components[i]
		part := diffPart{added: c.added, removed: c.removed}
		if c.removed {
			part.lines = old[o : o+c.count]
			o += c.count
		} else {
			part.lines = next[n : n+c.count]
			n += c.count
			if !c.added {
				o += c.count
			}
		}
		parts = append(parts, part)
	}
	return parts
}
func diffArrays(old, next []string) []diffPart {
	path := &diffPath{old: -1}
	n := commonDiff(path, old, next, 0)
	if path.old+1 >= len(old) && n+1 >= len(next) {
		return diffValues(path.last, old, next)
	}
	best := map[int]*diffPath{0: path}
	minimum, maximum := -len(old)-len(next), len(old)+len(next)
	for edits := 1; edits <= len(old)+len(next); edits++ {
		for diagonal := max(minimum, -edits); diagonal <= min(maximum, edits); diagonal += 2 {
			removed, added := best[diagonal-1], best[diagonal+1]
			delete(best, diagonal-1)
			canAdd := added != nil && added.old-diagonal >= 0 && added.old-diagonal < len(next)
			canRemove := removed != nil && removed.old+1 < len(old)
			if !canAdd && !canRemove {
				delete(best, diagonal)
				continue
			}
			if !canRemove || (canAdd && removed.old < added.old) {
				path = addDiff(added, true, false, 0)
			} else {
				path = addDiff(removed, false, true, 1)
			}
			n = commonDiff(path, old, next, diagonal)
			if path.old+1 >= len(old) && n+1 >= len(next) {
				return diffValues(path.last, old, next)
			}
			best[diagonal] = path
			if path.old+1 >= len(old) {
				maximum = min(maximum, diagonal-1)
			}
			if n+1 >= len(next) {
				minimum = max(minimum, diagonal+1)
			}
		}
	}
	return []diffPart{}
}
func DiffText(base, next string) []TextEdit {
	edits := []TextEdit{}
	position := 0
	parts := diffArrays(textLines(base), textLines(next))
	for i := 0; i < len(parts); i++ {
		part := parts[i]
		if !part.added && !part.removed {
			position += len(part.lines)
			continue
		}
		start, end := position, position
		added := []string{}
		if part.removed {
			end += len(part.lines)
			position = end
			if i+1 < len(parts) && parts[i+1].added {
				i++
				added = parts[i].lines
			}
		} else {
			added = part.lines
		}
		if end > start {
			replaced := min(end-start, len(added))
			for j := start; j < end; j++ {
				lines := []string{}
				if j-start < replaced {
					lines = []string{added[j-start]}
				}
				edits = append(edits, TextEdit{j, j + 1, lines})
			}
			if len(added) > replaced {
				edits = append(edits, TextEdit{end, end, added[replaced:]})
			}
		} else {
			edits = append(edits, TextEdit{start, end, added})
		}
	}
	return edits
}
func editsOverlap(a, b TextEdit, memory bool) bool {
	if a.Start == a.End && b.Start == b.End {
		return a.Start == b.Start
	}
	if a.Start == a.End {
		if memory {
			return a.Start > b.Start && a.Start < b.End
		}
		return a.Start >= b.Start && a.Start < b.End
	}
	if b.Start == b.End {
		if memory {
			return b.Start > a.Start && b.Start < a.End
		}
		return b.Start >= a.Start && b.Start < a.End
	}
	return a.Start < b.End && b.Start < a.End
}
func sortEdits(edits []TextEdit) {
	sort.SliceStable(edits, func(i, j int) bool {
		if edits[i].Start != edits[j].Start {
			return edits[i].Start < edits[j].Start
		}
		return edits[i].End < edits[j].End
	})
}
func applyEdits(original []string, start, end int, edits []TextEdit) string {
	sortEdits(edits)
	var result strings.Builder
	position := start
	for _, edit := range edits {
		result.WriteString(strings.Join(original[position:edit.Start], ""))
		result.WriteString(strings.Join(edit.Lines, ""))
		position = edit.End
	}
	result.WriteString(strings.Join(original[position:end], ""))
	return result.String()
}
func MergeText(base, current, incoming string) string {
	if incoming == base {
		return current
	}
	if current == base || current == incoming {
		return incoming
	}
	latest := DiffText(base, incoming)
	merged := []TextEdit{}
	for _, edit := range DiffText(base, current) {
		overlap := false
		for _, n := range latest {
			overlap = overlap || editsOverlap(edit, n, false)
		}
		if !overlap {
			merged = append(merged, edit)
		}
	}
	merged = append(merged, latest...)
	return applyEdits(textLines(base), 0, len(textLines(base)), merged)
}
